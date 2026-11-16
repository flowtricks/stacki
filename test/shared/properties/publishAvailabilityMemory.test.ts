// Goal: the Publish button's memory never shows a change that no check has confirmed.
// Method: drive the pure reducer with event sequences (first load, failures, flips, bursts) and
// assert what would be drawn after each step, plus the file-path filter for generated files.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_PUBLISH_AVAILABILITY_MEMORY,
  publishRelevantChange,
  reducePublishAvailability,
  shownPublishAvailability,
  type PublishAvailabilityEvent,
} from '#dist/shared/properties/publishAvailabilityMemory.js';

const current = { github: 'current', hosting: 'current' } as const;
const pending = { github: 'pending', hosting: 'current' } as const;
const unknown = { github: 'unknown', hosting: 'unknown' } as const;
const checked = (result: typeof current | typeof pending | typeof unknown): PublishAvailabilityEvent => ({ kind: 'checked', result });

function run(events: readonly PublishAvailabilityEvent[]) {
  let memory = EMPTY_PUBLISH_AVAILABILITY_MEMORY;
  const shown = [shownPublishAvailability(memory)];
  for (const event of events) {
    memory = reducePublishAvailability(memory, event);
    shown.push(shownPublishAvailability(memory));
  }
  return { memory, shown };
}

test('before any answer nothing is claimed, and a failure keeps it that way', () => {
  assert.deepEqual(run([{ kind: 'failed' }]).shown, [unknown, unknown]);
});

test('the first answer is confirmed at once, even when it says changes', () => {
  assert.deepEqual(run([checked(pending)]).shown.at(-1), pending);
});

test('failures and unjudged destinations keep the last confirmed state', () => {
  const { shown } = run([checked(current), { kind: 'failed' }, checked(unknown)]);
  assert.deepEqual(shown, [unknown, current, current, current]);
});

test('a clean-to-pending answer is held until a second check agrees', () => {
  const first = run([checked(current), checked(pending)]);
  assert.deepEqual(first.shown.at(-1), current);
  assert.notEqual(first.memory.held, undefined);
  const second = reducePublishAvailability(first.memory, checked(pending));
  assert.deepEqual(shownPublishAvailability(second), pending);
  assert.equal(second.held, undefined);
});

test('a flip that reverts is never shown: clean, dirty, clean', () => {
  const { shown, memory } = run([checked(current), checked(pending), checked(current)]);
  assert.equal(
    shown.some((value) => value.github === 'pending'),
    false,
  );
  assert.equal(memory.held, undefined);
});

test('pending to current and pending to pending are accepted immediately', () => {
  assert.deepEqual(run([checked(pending), checked(current)]).shown.at(-1), current);
  assert.deepEqual(run([checked(pending), checked({ github: 'pending', hosting: 'current' })]).shown.at(-1), pending);
});

test('no event sequence draws pending without a check that said pending', () => {
  const events: readonly PublishAvailabilityEvent[] = [checked(current), { kind: 'failed' }, checked(unknown), checked(current), { kind: 'failed' }];
  for (const shown of run(events).shown) {
    assert.notEqual(shown.github, 'pending');
  }
});

test('generated and scratch files are irrelevant; anything else, or an unnamed change, is relevant', () => {
  assert.equal(
    publishRelevantChange(['/p/.stacki/preview/a.html', '/p/node_modules/x/y.js', '/p/.astro/types.d.ts', '/p/src/.DS_Store', '/p/a.astro~']),
    false,
  );
  assert.equal(publishRelevantChange(['/p/.stacki/preview/a.html', '/p/src/a.astro']), true);
  assert.equal(publishRelevantChange(['/p/.stacki/components.json']), true);
  assert.equal(publishRelevantChange([]), true);
});
