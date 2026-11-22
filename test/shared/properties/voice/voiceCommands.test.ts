// Goal: spoken commands fire when they are commands and not when they are words in a sentence.
// "send" alone sends; "please send it to the server" is text. a break ("new line", "next line", "line break",
// "new paragraph") at a phrase edge is one blank line and is text inside a sentence;
// "scratch that" alone takes back the last piece, and inside a phrase drops what came before it.
// Methodology: each command whole, inside a sentence, with punctuation and capitals the
// recognizer adds, and the empty phrase; then the history that backs "delete that" when the box
// was typed in after the dictation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVoiceCommands, withParagraphBreak } from '#dist/shared/properties/voice/voiceCommands.js';
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

const BREAK = { kind: 'newline', count: 2 } as const;

test('every break phrase alone, or at a phrase edge, is one paragraph break, whatever the capitals or the mark', () => {
  for (const phrase of ['new line', 'New line.', 'next line', 'Line break!', 'new paragraph', 'Newline']) {
    assert.deepEqual(parseVoiceCommands(phrase), [BREAK], phrase);
  }
  assert.deepEqual(parseVoiceCommands('done new line'), [{ kind: 'insert', text: 'done' }, BREAK]);
  assert.deepEqual(parseVoiceCommands('New line. See how this will work.'), [BREAK, { kind: 'insert', text: 'See how this will work.' }]);
});

test('a break inside a sentence is text, not a command', () => {
  assert.deepEqual(parseVoiceCommands('add a new line of code'), [{ kind: 'insert', text: 'add a new line of code' }]);
  assert.deepEqual(parseVoiceCommands('first item new line second item'), [{ kind: 'insert', text: 'first item new line second item' }]);
  assert.deepEqual(parseVoiceCommands('the line break is wrong'), [{ kind: 'insert', text: 'the line break is wrong' }]);
});

test('breaks said one after another make one break', () => {
  assert.deepEqual(parseVoiceCommands('new line new line'), [BREAK]);
  assert.deepEqual(parseVoiceCommands('new line new paragraph next line'), [BREAK]);
  assert.deepEqual(parseVoiceCommands('done new line next line'), [{ kind: 'insert', text: 'done' }, BREAK]);
});

test('a paragraph break ends the text in exactly one blank line, trailing spaces gone, never three newlines', () => {
  assert.equal(withParagraphBreak('This is a test.'), 'This is a test.\n\n');
  assert.equal(withParagraphBreak('This is a test.   '), 'This is a test.\n\n');
  assert.equal(withParagraphBreak('This is a test.\n'), 'This is a test.\n\n');
  assert.equal(withParagraphBreak('This is a test.\n\n'), 'This is a test.\n\n', 'already broken: unchanged');
  assert.equal(withParagraphBreak('This is a test. \n\n\n'), 'This is a test.\n\n');
  assert.equal(withParagraphBreak(''), '', 'an empty box gets no blank lines');
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
