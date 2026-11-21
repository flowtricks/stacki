// Goal: the listening session behaves the same whoever drives it. A short press latches
// hands-free and the next press ends it; a held press is push-to-talk and letting go ends it;
// the recognizer's own pauses restart it up to a bound; silence ends only a hands-free session;
// and events that make no sense in a state (a release with nothing pressed, a second start) change nothing.
// Methodology: drive the pure reducer through whole sessions and through every state with every event.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isVoiceActive, reduceVoice, VOICE_IDLE, type VoiceEvent, type VoiceState } from '#dist/shared/properties/voice/voiceSession.js';
import { VOICE_LIMITS } from '#dist/shared/properties/voice/voiceLimits.js';

function run(events: readonly VoiceEvent[], from: VoiceState = VOICE_IDLE): { readonly state: VoiceState; readonly effects: readonly string[] } {
  let state = from;
  const effects: string[] = [];
  for (const event of events) {
    const step = reduceVoice(state, event);
    state = step.state;
    effects.push(step.effect);
  }
  return { state, effects };
}

test('a short press latches hands-free and the next press ends the session', () => {
  const { state, effects } = run([{ kind: 'press', atMs: 0 }, { kind: 'started' }, { kind: 'release', atMs: 120 }, { kind: 'press', atMs: 5000 }]);
  assert.deepEqual(effects, ['start', 'none', 'none', 'stop']);
  assert.equal(state.kind, 'stopping');
});

test('a held press is push to talk: letting go ends it', () => {
  const { state, effects } = run([{ kind: 'press', atMs: 0 }, { kind: 'started' }, { kind: 'release', atMs: VOICE_LIMITS.holdMsMin }]);
  assert.deepEqual(effects, ['start', 'none', 'stop']);
  assert.equal(state.kind, 'stopping');
});

test('letting go before the recognizer started still ends a hold, and a tap before it started still latches', () => {
  assert.equal(
    run([
      { kind: 'press', atMs: 0 },
      { kind: 'release', atMs: 900 },
    ]).state.kind,
    'stopping',
  );
  const tapped = run([{ kind: 'press', atMs: 0 }, { kind: 'release', atMs: 80 }, { kind: 'started' }]).state;
  assert.equal(tapped.kind, 'listening');
  assert.equal(tapped.kind === 'listening' ? tapped.latch : undefined, 'handsfree');
});

test('the recognizer ending itself restarts a session still wanted, up to the bound, then idles', () => {
  const latched = run([{ kind: 'press', atMs: 0 }, { kind: 'started' }, { kind: 'release', atMs: 10 }]).state;
  let state = latched;
  for (let index = 0; index < VOICE_LIMITS.restartsMax; index += 1) {
    const step = reduceVoice(state, { kind: 'ended' });
    assert.equal(step.effect, 'restart');
    state = step.state;
  }
  const last = reduceVoice(state, { kind: 'ended' });
  assert.equal(last.effect, 'none');
  assert.equal(last.state.kind, 'idle');
});

test('a session that was stopped ends in idle, and an end in idle stays idle', () => {
  assert.equal(reduceVoice({ kind: 'stopping' }, { kind: 'ended' }).state.kind, 'idle');
  assert.equal(reduceVoice(VOICE_IDLE, { kind: 'ended' }).state.kind, 'idle');
});

test('silence ends a hands-free session only, and only past the limit', () => {
  const handsfree = run([{ kind: 'press', atMs: 0 }, { kind: 'started' }, { kind: 'release', atMs: 10 }]).state;
  assert.equal(reduceVoice(handsfree, { kind: 'silence', silentMs: VOICE_LIMITS.silenceMsMax - 1 }).effect, 'none');
  assert.equal(reduceVoice(handsfree, { kind: 'silence', silentMs: VOICE_LIMITS.silenceMsMax }).effect, 'stop');
  const holding = run([{ kind: 'press', atMs: 0 }, { kind: 'started' }]).state;
  assert.equal(reduceVoice(holding, { kind: 'silence', silentMs: VOICE_LIMITS.silenceMsMax * 5 }).effect, 'none');
});

test('a failed start goes back to idle; a failure with nothing starting changes nothing', () => {
  assert.equal(run([{ kind: 'press', atMs: 0 }, { kind: 'failed' }]).state.kind, 'idle');
  assert.equal(reduceVoice(VOICE_IDLE, { kind: 'failed' }).state.kind, 'idle');
  const listening = run([{ kind: 'press', atMs: 0 }, { kind: 'started' }]).state;
  assert.equal(reduceVoice(listening, { kind: 'failed' }).state, listening);
});

test('events that make no sense change nothing and ask for nothing', () => {
  assert.deepEqual(reduceVoice(VOICE_IDLE, { kind: 'release', atMs: 5 }), { state: VOICE_IDLE, effect: 'none' });
  assert.deepEqual(reduceVoice(VOICE_IDLE, { kind: 'stop' }), { state: VOICE_IDLE, effect: 'none' });
  assert.deepEqual(reduceVoice(VOICE_IDLE, { kind: 'started' }), { state: VOICE_IDLE, effect: 'none' });
  assert.deepEqual(reduceVoice(VOICE_IDLE, { kind: 'silence', silentMs: 1e9 }), { state: VOICE_IDLE, effect: 'none' });
  const stopping: VoiceState = { kind: 'stopping' };
  assert.deepEqual(reduceVoice(stopping, { kind: 'press', atMs: 1 }), { state: stopping, effect: 'none' });
  assert.deepEqual(reduceVoice(stopping, { kind: 'stop' }), { state: stopping, effect: 'none' });
});

test('a second press while the first is still down is a repeat, not a stop', () => {
  const pressed = reduceVoice(VOICE_IDLE, { kind: 'press', atMs: 0 }).state;
  assert.deepEqual(reduceVoice(pressed, { kind: 'press', atMs: 10 }), { state: pressed, effect: 'none' });
});

test('a stop from anywhere active ends the session whatever the latch', () => {
  const holding = run([{ kind: 'press', atMs: 0 }, { kind: 'started' }]).state;
  assert.equal(reduceVoice(holding, { kind: 'stop' }).effect, 'stop');
  assert.equal(isVoiceActive(holding), true);
  assert.equal(isVoiceActive(VOICE_IDLE), false);
  assert.equal(isVoiceActive({ kind: 'stopping' }), false);
});

test('a release that comes before its press is a programmer error', () => {
  const pressed = reduceVoice(VOICE_IDLE, { kind: 'press', atMs: 1000 }).state;
  assert.throws(() => reduceVoice(pressed, { kind: 'release', atMs: 900 }), /released after it was pressed/u);
});
