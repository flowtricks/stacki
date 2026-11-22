// Goal: a screenshot leaves main only as a bounded image in the reply, never as a file. A small capture
// is PNG, a Retina-sized one is scaled to the edge bound keeping its aspect, a PNG past the size target
// falls back to JPEG at falling quality, an image too detailed for any quality is refused as a value, and
// an empty or failed capture is a value too. The module imports no file-system or temp-directory API, so
// there is no temporary file to create, leak or clean up.
// Methodology: the encoder and capture from dist/ against a stand-in NativeImage whose encoded sizes the
// test chooses, and a scan of the compiled module's imports.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { test } from 'node:test';
import {
  captureScreenshot,
  cssRectToWindow,
  encodeScreenshot,
  SCREENSHOT_BASE64_CHARS_TARGET,
  type ScreenshotImage,
} from '#dist/electron/handlers/ai/screenshotCapture.js';
import { SCREENSHOT_EDGE_PX_MAX } from '#dist/shared/ipc/aiChat.js';

interface FakeOptions {
  readonly width: number;
  readonly height: number;
  /** Bytes of the PNG, and of the JPEG at each quality. */
  readonly pngBytes: number;
  readonly jpegBytes: (quality: number) => number;
  readonly empty?: boolean;
  readonly resized?: { width: number; height: number }[];
}

// The image as captured; its one resize gives an image that may not be resized again (the encoder resizes once).
function fakeImage(options: FakeOptions): ScreenshotImage {
  return {
    ...encoded(options),
    resize: (size) => {
      options.resized?.push({ width: size.width, height: size.height });
      return { ...encoded({ ...options, width: size.width, height: size.height }), resize: () => assert.fail('resized twice') };
    },
  };
}

function encoded(options: FakeOptions): Omit<ScreenshotImage, 'resize'> {
  return {
    isEmpty: () => options.empty === true,
    getSize: () => ({ width: options.width, height: options.height }),
    toPNG: () => Buffer.alloc(options.pngBytes, 1),
    toJPEG: (quality) => Buffer.alloc(options.jpegBytes(quality), 2),
  };
}

// Bytes whose base64 is just within, or just past, the target.
const FITS = Math.floor((SCREENSHOT_BASE64_CHARS_TARGET / 4) * 3) - 3;
const TOO_BIG = FITS + 3_000;

test('a small capture is a PNG of its own size', () => {
  const result = encodeScreenshot(fakeImage({ width: 400, height: 300, pngBytes: 1_000, jpegBytes: () => 1 }));
  assert.ok(result.ok);
  assert.equal(result.value.mimeType, 'image/png');
  assert.equal(result.value.width, 400);
  assert.equal(result.value.height, 300);
  assert.equal(Buffer.from(result.value.data, 'base64').length, 1_000);
});

test('a Retina-sized capture is scaled to the edge bound, keeping its aspect', () => {
  const resized: { width: number; height: number }[] = [];
  const result = encodeScreenshot(fakeImage({ width: 3200, height: 1801, pngBytes: 1_000, jpegBytes: () => 1, resized }));
  assert.ok(result.ok);
  assert.deepEqual(resized, [{ width: SCREENSHOT_EDGE_PX_MAX, height: 900 }], 'floored, so no side passes the bound');
  assert.equal(result.value.width, SCREENSHOT_EDGE_PX_MAX);
  const tall = encodeScreenshot(fakeImage({ width: 10, height: 20_000, pngBytes: 10, jpegBytes: () => 1 }));
  assert.ok(tall.ok);
  assert.equal(tall.value.height, SCREENSHOT_EDGE_PX_MAX);
  assert.equal(tall.value.width, 1, 'a sliver keeps at least a pixel');
});

test('a PNG past the target falls back to JPEG at the first quality that fits', () => {
  const asked: number[] = [];
  const result = encodeScreenshot(
    fakeImage({
      width: 1600,
      height: 1000,
      pngBytes: TOO_BIG,
      jpegBytes: (quality) => {
        asked.push(quality);
        return quality > 60 ? TOO_BIG : FITS;
      },
    }),
  );
  assert.ok(result.ok);
  assert.equal(result.value.mimeType, 'image/jpeg');
  assert.ok(result.value.data.length <= SCREENSHOT_BASE64_CHARS_TARGET);
  assert.deepEqual(asked, [90, 75, 60]);
});

test('too detailed, empty or a failed capture: an expected failure, not a throw', async () => {
  const detailed = encodeScreenshot(fakeImage({ width: 1600, height: 1000, pngBytes: TOO_BIG, jpegBytes: () => TOO_BIG }));
  assert.ok(!detailed.ok);
  assert.equal(detailed.error.code, 'invalid');
  const empty = encodeScreenshot(fakeImage({ width: 0, height: 0, pngBytes: 0, jpegBytes: () => 0, empty: true }));
  assert.ok(!empty.ok);
  assert.equal(empty.error.message, 'Could not take the screenshot. Try again.');
  const failed = await captureScreenshot({ capturePage: () => Promise.reject(new Error('window gone')) }, { x: 0, y: 0, width: 10, height: 10 });
  assert.ok(!failed.ok);
  assert.ok(!failed.error.message.includes('window gone'), 'the reason is not passed on');
});

test('the capture photographs the asked rect of the sender and nothing else', async () => {
  const asked: unknown[] = [];
  const result = await captureScreenshot(
    {
      capturePage: (rect, options) => {
        asked.push({ rect, options });
        return Promise.resolve(fakeImage({ width: 20, height: 10, pngBytes: 8, jpegBytes: () => 1 }));
      },
    },
    { x: 5, y: 6, width: 20, height: 10 },
  );
  assert.ok(result.ok);
  assert.deepEqual(asked, [{ rect: { x: 5, y: 6, width: 20, height: 10 }, options: { stayHidden: false, stayAwake: false } }]);
  await assert.rejects(() => captureScreenshot({ capturePage: () => Promise.reject(new Error('x')) }, { x: 0, y: 0, width: 0, height: 1 }), /empty rect/);
});

test('the screenshot module touches no file: no fs, os or temp-directory import', () => {
  const compiled = fs.readFileSync(new URL(import.meta.resolve('#dist/electron/handlers/ai/screenshotCapture.js')), 'utf8');
  for (const forbidden of ['node:fs', 'node:os', "'fs'", "'os'", 'mkdtemp', 'tmpdir', 'writeFile']) {
    assert.ok(!compiled.includes(forbidden), `screenshotCapture imports nothing like ${forbidden}`);
  }
});

test('a zoomed page photographs the same region: CSS pixels become window pixels, rounded outwards', () => {
  const rect = { x: 10, y: 20, width: 300, height: 100 };
  assert.deepEqual(cssRectToWindow(rect, 1), rect, 'the default zoom changes nothing');
  assert.deepEqual(cssRectToWindow(rect, 1.25), { x: 12, y: 25, width: 376, height: 125 });
  assert.deepEqual(cssRectToWindow({ x: 3, y: 3, width: 3, height: 3 }, 0.5), { x: 1, y: 1, width: 2, height: 2 }, 'zoomed out, outwards still');
  assert.throws(() => cssRectToWindow(rect, 0), /positive zoom/);
});
