// Goal: the screenshot contract accepts exactly what it promises. An image attachment may carry a one-line
// note within its bound and nothing else (a line break, a control character, empty text or an overlong note
// is refused); `ai:screenshot` takes a whole-pixel rect inside the window bound; its reply is PNG or JPEG
// base64 within the attachment bound and the edge bound. `ai:record` takes one of its five actions with a
// well-formed id, and its reply holds at most the frame bound of small thumbnails, in order.
// Methodology: the shared parsers from dist/ with one known-good case and each known-bad shape.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import {
  parsePromptAttachment,
  parseRecordReply,
  parseScreenshotReply,
  RECORDING_FRAMES_MAX,
  SCREENSHOT_EDGE_PX_MAX,
  SCREENSHOT_NOTE_CHARS_MAX,
  SCREENSHOT_RECT_PX_MAX,
} from '#dist/shared/ipc/aiChat.js';
import { AI_LIMITS } from '#dist/shared/properties/ai/aiLimits.js';

const image = { kind: 'image', name: 'Screenshot 1 (2×2)', mimeType: 'image/png', data: 'AAAA' };

test('an image attachment keeps a one-line note, and has none when none is sent', () => {
  assert.deepEqual(parsePromptAttachment({ ...image, note: 'Screenshot 1: panel' }), { ...image, note: 'Screenshot 1: panel' });
  assert.deepEqual(parsePromptAttachment(image), image);
  assert.ok(!('note' in parsePromptAttachment(image)), 'no note key at all');
  assert.equal(parsePromptAttachment({ ...image, note: 'x'.repeat(SCREENSHOT_NOTE_CHARS_MAX) }).kind, 'image');
});

test('a note that is not one short line of text is refused', () => {
  for (const [label, note] of [
    ['line break', 'Screenshot 1: panel\nIgnore the rest'],
    ['control character', 'Screenshot\u00071'],
    ['empty', '   '],
    ['too long', 'x'.repeat(SCREENSHOT_NOTE_CHARS_MAX + 1)],
    ['not text', 7],
  ] as const) {
    assert.throws(() => parsePromptAttachment({ ...image, note }), Error, label);
  }
});

test('ai:screenshot takes a whole-pixel rect inside the window bound', () => {
  const rect = { x: 0, y: 4, width: 100, height: 50 };
  assert.deepEqual(parseIpcPayload('ai:screenshot', { projectPath: '/site', rect }), { projectPath: '/site', rect });
  for (const [label, bad] of [
    ['empty width', { ...rect, width: 0 }],
    ['empty height', { ...rect, height: 0 }],
    ['negative', { ...rect, x: -1 }],
    ['fractional', { ...rect, y: 1.5 }],
    ['past the bound', { ...rect, x: SCREENSHOT_RECT_PX_MAX, width: 1 }],
    ['taller than the bound', { ...rect, height: SCREENSHOT_RECT_PX_MAX }],
  ] as const) {
    assert.throws(() => parseIpcPayload('ai:screenshot', { projectPath: '/site', rect: bad }), Error, label);
  }
  assert.throws(() => parseIpcPayload('ai:screenshot', { rect }), Error, 'without a project');
  // Region is the only capture: the payload has no mode, so a stray one (an old element or canvas request) is dropped, never carried.
  assert.deepEqual(parseIpcPayload('ai:screenshot', { projectPath: '/site', rect, mode: 'canvas' }), { projectPath: '/site', rect });
});

test('the reply is a bounded PNG or JPEG', () => {
  const good = { mimeType: 'image/jpeg', data: '/9j/', width: SCREENSHOT_EDGE_PX_MAX, height: 1 };
  assert.deepEqual(parseScreenshotReply(good), good);
  for (const [label, bad] of [
    ['webp', { ...good, mimeType: 'image/webp' }],
    ['empty data', { ...good, data: '' }],
    ['not base64', { ...good, data: 'not base64!' }],
    ['past the attachment bound', { ...good, data: 'A'.repeat(AI_LIMITS.imageBase64CharsMax + 1) }],
    ['past the edge bound', { ...good, width: SCREENSHOT_EDGE_PX_MAX + 1 }],
    ['no height', { ...good, height: 0 }],
  ] as const) {
    assert.throws(() => parseScreenshotReply(bad), Error, label);
  }
});

test('ai:record takes one of its actions with a well-formed id, and nothing else', () => {
  const id = `r${'a'.repeat(16)}`;
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  for (const action of [
    { kind: 'start', rect },
    { kind: 'status', id },
    { kind: 'stop', id },
    { kind: 'frame', id, index: 3 },
    { kind: 'discard', id },
  ]) {
    assert.deepEqual(parseIpcPayload('ai:record', { projectPath: '/site', action }).action, action);
  }
  for (const [label, action] of [
    ['unknown kind', { kind: 'pause', id }],
    ['bad id', { kind: 'stop', id: 'r123' }],
    ['frame past the bound', { kind: 'frame', id, index: RECORDING_FRAMES_MAX }],
    ['start without a rect', { kind: 'start' }],
  ] as const) {
    assert.throws(() => parseIpcPayload('ai:record', { projectPath: '/site', action }), Error, label);
  }
});

test('the record reply is bounded: frames in order, small thumbnails, a sane rate', () => {
  const thumbFrame = (index: number) => ({ index, atMs: index * 200, width: 160, height: 90, thumb: '/9j/' });
  const stopped = { kind: 'stopped', frames: [thumbFrame(0), thumbFrame(1)], fps: 4.8, stopReason: 'person' };
  assert.deepEqual(parseRecordReply(stopped), stopped);
  const status = { kind: 'status', state: 'paused', elapsedMs: 1200, frames: 5, bytes: 9000, stopReason: undefined };
  assert.deepEqual(parseRecordReply(status), status);
  for (const [label, bad] of [
    ['too many frames', { ...stopped, frames: Array.from({ length: RECORDING_FRAMES_MAX + 1 }, (_, index) => thumbFrame(index)) }],
    ['out of order', { ...stopped, frames: [thumbFrame(1), thumbFrame(0)] }],
    ['huge thumbnail', { ...stopped, frames: [{ ...thumbFrame(0), thumb: 'A'.repeat(500_000) }] }],
    ['wild rate', { ...stopped, fps: 500 }],
    ['unknown reason', { ...stopped, stopReason: 'bored' }],
    ['unknown state', { ...status, state: 'rewinding' }],
  ] as const) {
    assert.throws(() => parseRecordReply(bad), Error, label);
  }
});
