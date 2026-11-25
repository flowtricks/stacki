// Goal: a sent image's stored thumbnail is checked at the boundary: a bounded JPEG data URL on an image
// is accepted, and a missing one (a chat stored before thumbnails) still reads and stays absent.
// Methodology: parseChatEvent is fed a known-good user event, then each bad shape in turn (too long, wrong
// media type, not base64, not a string, on a file); the limit's own edge is pinned on both sides.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_LIMITS } from '#dist/shared/properties/ai/aiLimits.js';
import { THUMBNAIL_PREFIX, parseChatEvent } from '#dist/shared/properties/ai/chatModel.js';

/** JSON's null, as a stored file can hold it. */
const jsonNull: unknown = JSON.parse('null');
const turn = `t${'1'.repeat(16)}`;
const small = `${THUMBNAIL_PREFIX}/9j/4AAQSkZJRg==`;
const userWith = (attachment: unknown): unknown => ({ kind: 'user', turn, text: 'look', attachments: [attachment], at: 1 });
const thumbnailOf = (event: ReturnType<typeof parseChatEvent>): unknown => {
  assert.equal(event.kind, 'user');
  return event.kind === 'user' ? event.attachments[0]?.thumbnail : undefined;
};

test('an image attachment keeps a valid thumbnail', () => {
  assert.equal(thumbnailOf(parseChatEvent(userWith({ kind: 'image', name: 'Screenshot 1 (1600×933)', thumbnail: small }))), small);
});

test('an attachment stored before thumbnails reads and has none', () => {
  const event = parseChatEvent(userWith({ kind: 'image', name: 'Screenshot 1 (1600×933)' }));
  assert.equal(thumbnailOf(event), undefined);
  assert.equal(event.kind === 'user' && 'thumbnail' in (event.attachments[0] ?? {}), false, 'the key is absent, not undefined');
});

test('a thumbnail at the limit passes and one character over is refused', () => {
  const urlOfLength = (length: number): string => THUMBNAIL_PREFIX + 'A'.repeat(length - THUMBNAIL_PREFIX.length);
  const atLimit = urlOfLength(AI_LIMITS.thumbnailCharsMax);
  assert.equal(thumbnailOf(parseChatEvent(userWith({ kind: 'image', name: 'a', thumbnail: atLimit }))), atLimit);
  assert.throws(() => parseChatEvent(userWith({ kind: 'image', name: 'a', thumbnail: urlOfLength(AI_LIMITS.thumbnailCharsMax + 1) })), /exceeds limit/);
});

test('a thumbnail of the wrong type, shape or owner is refused', () => {
  const bad: readonly unknown[] = [
    { kind: 'image', name: 'a', thumbnail: 'data:image/png;base64,AAAA' },
    { kind: 'image', name: 'a', thumbnail: 'data:text/html;base64,AAAA' },
    { kind: 'image', name: 'a', thumbnail: 'https://example.com/a.jpg' },
    { kind: 'image', name: 'a', thumbnail: `${THUMBNAIL_PREFIX}not base64!` },
    { kind: 'image', name: 'a', thumbnail: THUMBNAIL_PREFIX },
    { kind: 'image', name: 'a', thumbnail: 12 },
    { kind: 'image', name: 'a', thumbnail: jsonNull },
    { kind: 'file', name: 'src/a.ts', thumbnail: small },
  ];
  for (const attachment of bad) {
    assert.throws(() => parseChatEvent(userWith(attachment)), `refused: ${JSON.stringify(attachment)}`);
  }
});
