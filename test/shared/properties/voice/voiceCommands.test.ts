// Goal: spoken commands fire when they are commands and not when they are words in a sentence.
// "send" alone sends; "please send it to the server" is text. "new line" breaks a line anywhere;
// "scratch that" alone takes back the last piece, and inside a phrase drops what came before it.
// Methodology: each command whole, inside a sentence, with punctuation and capitals the
// recognizer adds, and the empty phrase; then the history that backs "delete that" when the box
// was typed in after the dictation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVoiceCommands } from '#dist/shared/properties/voice/voiceCommands.js';
import { pushDictated, takeBackLast } from '#dist/shared/properties/voice/voiceHistory.js';
import { VOICE_LIMITS } from '#dist/shared/properties/voice/voiceLimits.js';

test('a phrase that is only a command is that command, whatever the capitals or the mark', () => {
  assert.deepEqual(parseVoiceCommands('send'), [{ kind: 'send' }]);
  assert.deepEqual(parseVoiceCommands('Send it.'), [{ kind: 'send' }]);
  assert.deepEqual(parseVoiceCommands('stop listening'), [{ kind: 'stop' }]);
  assert.deepEqual(parseVoiceCommands('Scratch that!'), [{ kind: 'deleteLast' }]);
  assert.deepEqual(parseVoiceCommands('delete that'), [{ kind: 'deleteLast' }]);
});

test('the same words inside a sentence are text, never a command', () => {
  assert.deepEqual(parseVoiceCommands('please send it to the server'), [{ kind: 'insert', text: 'please send it to the server' }]);
  assert.deepEqual(parseVoiceCommands('send the message now'), [{ kind: 'insert', text: 'send the message now' }]);
  assert.deepEqual(parseVoiceCommands('stop listening to me'), [{ kind: 'insert', text: 'stop listening to me' }]);
});

test('new line and new paragraph break inside a phrase', () => {
  assert.deepEqual(parseVoiceCommands('first item new line second item'), [
    { kind: 'insert', text: 'first item' },
    { kind: 'newline', count: 1 },
    { kind: 'insert', text: 'second item' },
  ]);
  assert.deepEqual(parseVoiceCommands('new paragraph'), [{ kind: 'newline', count: 2 }]);
  assert.deepEqual(parseVoiceCommands('done new line'), [
    { kind: 'insert', text: 'done' },
    { kind: 'newline', count: 1 },
  ]);
});

test('scratch that inside a phrase drops the words said before it', () => {
  assert.deepEqual(parseVoiceCommands('buy milk scratch that buy eggs'), [{ kind: 'insert', text: 'buy eggs' }]);
  assert.deepEqual(parseVoiceCommands('buy milk scratch that'), []);
});

test('an empty phrase has no actions', () => {
  assert.deepEqual(parseVoiceCommands(''), []);
  assert.deepEqual(parseVoiceCommands('   '), []);
});

test('a phrase past the word bound is cut, not looped without end', () => {
  const long = Array.from({ length: VOICE_LIMITS.utteranceWordsMax + 50 }, () => 'word').join(' ');
  const actions = parseVoiceCommands(long);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.kind, 'insert');
});

test('"delete that" takes the last dictated piece back and never reaches into typing', () => {
  let history = pushDictated([], 'Fix the header.');
  history = pushDictated(history, 'Make it blue.');
  const taken = takeBackLast(history, 'Fix the header. Make it blue.');
  assert.equal(taken.text, 'Fix the header.');
  assert.equal(taken.removed, true);
  assert.deepEqual(taken.history, ['Fix the header.']);
  const typedAfter = takeBackLast(history, 'Fix the header. Make it blue. and more');
  assert.equal(typedAfter.removed, false);
  assert.equal(typedAfter.text, 'Fix the header. Make it blue. and more');
  assert.deepEqual(takeBackLast([], 'text'), { history: [], text: 'text', removed: false });
});

test('the history is bounded and ignores empty pieces', () => {
  let history: readonly string[] = [];
  for (let index = 0; index < VOICE_LIMITS.historyMax + 10; index += 1) {
    history = pushDictated(history, `piece ${index}`);
  }
  assert.equal(history.length, VOICE_LIMITS.historyMax);
  assert.equal(history[history.length - 1], `piece ${VOICE_LIMITS.historyMax + 9}`);
  assert.equal(pushDictated(history, ''), history);
});
