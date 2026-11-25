// Goal: a permission answer takes effect exactly once and a repeat of it is harmless. The first answer
// settles the request; an echo of it (a held key, a double click) reports `repeat` without settling
// anything twice; an answer to a request that was cancelled, never existed, belongs to another chat or
// names an option it did not offer reports `unknown`, which the host turns into the "expired" message.
// Methodology: the real broker from dist/, driven directly. Each case asks one request, answers it in
// the way under test, and checks the outcome, the settle count and the pending count.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionBroker } from '#dist/electron/handlers/ai/permissionBroker.js';
import { toChatId, toPermissionRequestId } from '#dist/shared/properties/ai/chatModel.js';

const CHAT = toChatId(`c${'a'.repeat(24)}`);
const OTHER = toChatId(`c${'b'.repeat(24)}`);

function asked(broker: PermissionBroker, chat = CHAT) {
  const outcomes: unknown[] = [];
  const request = broker.ask(chat, ['yes', 'no'], (outcome) => outcomes.push(outcome));
  assert.ok(request !== undefined);
  return { request: request.request, outcomes };
}

test('the first answer settles the request and a double answer is a repeat, not a second settle', () => {
  const broker = new PermissionBroker();
  const { request, outcomes } = asked(broker);
  assert.equal(broker.answer(CHAT, request, { kind: 'option', optionId: 'yes' }), 'accepted');
  assert.equal(broker.answer(CHAT, request, { kind: 'option', optionId: 'yes' }), 'repeat');
  assert.equal(broker.answer(CHAT, request, { kind: 'option', optionId: 'no' }), 'repeat', 'a different late option does not reopen it');
  assert.equal(outcomes.length, 1, 'the agent hears one answer');
  assert.equal(broker.pendingCount, 0);
});

test('a cancel answer also counts as answered once', () => {
  const broker = new PermissionBroker();
  const { request, outcomes } = asked(broker);
  assert.equal(broker.answer(CHAT, request, { kind: 'cancel' }), 'accepted');
  assert.equal(broker.answer(CHAT, request, { kind: 'cancel' }), 'repeat');
  assert.equal(outcomes.length, 1);
});

test('an unknown request id is unknown', () => {
  const broker = new PermissionBroker();
  assert.equal(broker.answer(CHAT, toPermissionRequestId('p999'), { kind: 'option', optionId: 'yes' }), 'unknown');
});

test('a request cancelled by a stop is expired, not a repeat', () => {
  const broker = new PermissionBroker();
  const { request } = asked(broker);
  broker.cancel(CHAT);
  assert.equal(broker.answer(CHAT, request, { kind: 'option', optionId: 'yes' }), 'unknown');
});

test("another chat cannot answer, or repeat, a chat's request", () => {
  const broker = new PermissionBroker();
  const { request } = asked(broker);
  assert.equal(broker.answer(OTHER, request, { kind: 'option', optionId: 'yes' }), 'unknown');
  assert.equal(broker.answer(CHAT, request, { kind: 'option', optionId: 'yes' }), 'accepted');
  assert.equal(broker.answer(OTHER, request, { kind: 'option', optionId: 'yes' }), 'unknown');
});

test('an option the request did not offer is unknown and leaves it waiting', () => {
  const broker = new PermissionBroker();
  const { request } = asked(broker);
  assert.equal(broker.answer(CHAT, request, { kind: 'option', optionId: 'bogus' }), 'unknown');
  assert.equal(broker.pendingCount, 1);
});
