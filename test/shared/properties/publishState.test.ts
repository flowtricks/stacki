// Goal: the main Publish button rests as "current" exactly when its default target has nothing
// left to commit, push or deploy, using the same destination states the menu rows read.
// Method: enumerate every destination state for every target and compare against a table
// written out by hand, then check that any change at all brings the button back to "ready".
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDesktopPublishState, publishButtonState } from '#dist/shared/properties/publishState.js';

const GITHUB = ['current', 'pending', 'unknown'] as const;
const HOSTING = ['current', 'pending', 'unknown', 'unconfigured'] as const;

test('publishing everything is current only when GitHub is current and hosting is current or not set up', () => {
  for (const github of GITHUB) {
    for (const hosting of HOSTING) {
      const finished = github === 'current' && (hosting === 'current' || hosting === 'unconfigured');
      assert.equal(publishButtonState({ github, hosting }, 'all'), finished ? 'current' : 'ready', `${github}/${hosting}`);
    }
  }
});

test('a single-destination default reads only its own destination', () => {
  for (const github of GITHUB) {
    for (const hosting of HOSTING) {
      assert.equal(publishButtonState({ github, hosting }, 'github'), github === 'current' ? 'current' : 'ready', `github ${github}/${hosting}`);
      assert.equal(publishButtonState({ github, hosting }, 'hosting'), hosting === 'current' ? 'current' : 'ready', `hosting ${github}/${hosting}`);
    }
  }
});

test('the first change after a finished publish makes the button ready again', () => {
  const published = { github: 'current', hosting: 'current', githubPush: { commits: 0, repositoryUrl: 'https://github.com/a/b' } } as const;
  assert.equal(publishButtonState(published, 'all'), 'current');
  // A new commit, a pending deploy, and a recheck that has not answered yet each count as work.
  assert.equal(publishButtonState({ ...published, github: 'pending', githubPush: { commits: 1, repositoryUrl: 'https://github.com/a/b' } }, 'all'), 'ready');
  assert.equal(publishButtonState({ ...published, hosting: 'pending' }, 'all'), 'ready');
  assert.equal(publishButtonState({ github: 'unknown', hosting: 'unknown' }, 'all'), 'ready');
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
