// Goal: the editor's frames never add back steps of their own. Frames share the tab's
// history, so a canvas or preview frame whose `src` changes pushes an entry: in the demo,
// each page opened during preview added two entries, back stopped at the editor's own
// loads, and stepping back reopened a page that pushed again and dropped forward.
// Method: point a stand-in frame at a second address through replaceFrameAddress and
// check it replaced the frame's location rather than setting `src`; a frame on another
// origin (its location throws) falls back to `src`. The demo's host is checked to let
// the preview's own navigation take over the entry it made (demoPageAddress.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceFrameAddress } from '../src/features/preview/frameAddress';
import { addressFollowsPreview, addressHistoryFor } from '../src/features/project/pageAddress';

function standIn(throws: boolean) {
  const replaced: string[] = [];
  const frame = {
    src: 'http://localhost:8787/demo/site/#avb-design',
    contentWindow: {
      location: {
        replace: (url: string) => {
          if (throws) {
            throw new DOMException('Blocked a frame with another origin', 'SecurityError');
          }
          replaced.push(url);
        },
      },
    } as unknown as Window,
  };
  return { frame, replaced };
}

test('a later address replaces the frame location, adding no history entry', () => {
  const { frame, replaced } = standIn(false);
  replaceFrameAddress(frame, 'http://localhost:8787/demo/site/studio/#avb-design');
  assert.deepEqual(replaced, ['http://localhost:8787/demo/site/studio/#avb-design']);
  assert.equal(frame.src, 'http://localhost:8787/demo/site/#avb-design', 'src is left as the first address');
});

test('a frame on another origin falls back to src', () => {
  const { frame, replaced } = standIn(true);
  replaceFrameAddress(frame, 'https://elsewhere.example/page');
  assert.deepEqual(replaced, []);
  assert.equal(frame.src, 'https://elsewhere.example/page');
  assert.throws(() => replaceFrameAddress(frame, ''), /not empty/);
});

test("the preview's own navigation replaces the address once; a switcher pick pushes", () => {
  addressFollowsPreview('/docs/');
  assert.equal(addressHistoryFor('/docs'), 'replace');
  assert.equal(addressHistoryFor('/docs'), 'push', 'taken once');
  addressFollowsPreview('/studio');
  assert.equal(addressHistoryFor('/docs'), 'push', 'another page is the visitor picking it');
  assert.equal(addressHistoryFor('/studio'), 'push', 'and the stale route is dropped');
  assert.throws(() => addressFollowsPreview('studio'), /site path/);
});
