// Goal: in the demo, the title-bar Publish button starts blue (three commits to push, a deploy
// pending), greys out once a pretend publish finishes, and turns blue again after a new edit.
// Method: drive the demo's publish model through a full run and an edit, read each availability
// answer through the shared parser, and map it with the same function the button uses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePublishAvailability, publishButtonState } from '../vendor/stacki/shared/properties/publishState';
import { DEMO_COMMITS_START, DemoPublish } from '../demo/publish';

function demoButton(publish: DemoPublish) {
  return publishButtonState(parsePublishAvailability(publish.availability()), 'all');
}

test('the demo Publish button greys out after a publish and returns after an edit', () => {
  let saved: string | undefined;
  const publish = new DemoPublish({ siteURL: 'https://x.test/', saved: undefined, persist: (text) => (saved = text), finished: () => undefined });
  const start = parsePublishAvailability(publish.availability());
  assert.equal(start.githubPush?.commits, DEMO_COMMITS_START);
  assert.equal(demoButton(publish), 'ready', 'The demo starts with work to publish');
  publish.start('all');
  for (let poll = 0; poll < 4; poll++) {
    publish.poll();
  }
  assert.equal(publish.poll().kind, 'committed');
  assert.equal(demoButton(publish), 'current', 'A finished publish leaves nothing to push or deploy');
  // A reload keeps the finished state rather than starting the demo over.
  assert.equal(demoButton(new DemoPublish({ siteURL: 'https://x.test/', saved, persist: () => undefined, finished: () => undefined })), 'current');
  publish.edit();
  assert.equal(demoButton(publish), 'ready', 'An edit gives the button something to publish again');
});

test('a partial demo publish keeps the button ready for the other destination', () => {
  const publish = new DemoPublish({ siteURL: 'https://x.test/', saved: undefined, persist: () => undefined, finished: () => undefined });
  publish.start('github');
  for (let poll = 0; poll < 2; poll++) {
    publish.poll();
  }
  const availability = parsePublishAvailability(publish.availability());
  assert.equal(availability.github, 'current');
  assert.equal(availability.hosting, 'pending');
  assert.equal(publishButtonState(availability, 'all'), 'ready');
});
