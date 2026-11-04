// What an external media value is allowed to preview as.
//
//   node test/renderer/ui/remoteMedia.test.js
//
// The Settings panel's src card loads external values straight into the
// editor's own document, so the classifier is a security boundary as much as
// a convenience. This bundles src/ui/remoteMedia.ts and checks it from both
// sides: the values that should preview (http and https images and videos,
// protocol-relative URLs read as https, data:image URLs, blob URLs) come back
// with the exact source to load, and every value that should not — other
// schemes, non-image data: URLs, relative paths, audio, oversized values —
// comes back "unknown", which loads nothing.

const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'remote-media.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/ui/remoteMedia.ts')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { classifyRemoteMedia, remotePosterSource, REMOTE_MEDIA_LIMITS } = require(bundlePath);
  const expect = (what, value, hint, kind, source) => {
    const media = classifyRemoteMedia(value, hint);
    check(`${what}: kind`, media.kind === kind, `${value} (${hint}) → ${JSON.stringify(media)}`);
    if (source !== undefined) {
      check(`${what}: source`, media.source === source, `${value} → ${JSON.stringify(media)}`);
    }
  };

  // --- Images ------------------------------------------------------------------
  expect('https image', 'https://cdn.example.com/hero.png', 'image', 'image', 'https://cdn.example.com/hero.png');
  expect('http image', 'http://cdn.example.com/a/b.JPG?w=8', 'asset', 'image', 'http://cdn.example.com/a/b.JPG?w=8');
  expect('protocol-relative image is https', '//cdn.example.com/x.png', 'image', 'image', 'https://cdn.example.com/x.png');
  expect('surrounding whitespace is ignored', '  https://cdn.example.com/x.webp  ', 'image', 'image', 'https://cdn.example.com/x.webp');
  expect('extensionless CDN URL in an image field', 'https://images.example.com/photo?id=4', 'image', 'image');
  expect('extensionless URL in a generic field tries an image', 'https://images.example.com/photo', 'asset', 'image');
  expect('data:image URL', 'data:image/png;base64,iVBORw0KGgo=', 'image', 'image', 'data:image/png;base64,iVBORw0KGgo=');
  expect('data:image/svg+xml URL', 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E', 'asset', 'image');
  expect('blob URL in an image field', 'blob:https://example.com/2f1c', 'image', 'image', 'blob:https://example.com/2f1c');

  // --- Videos -------------------------------------------------------------------
  expect(
    'webm from the report seeks to a frame',
    'https://pidgin-36m.pages.dev/hero-pigeon-v3.webm',
    'image',
    'video',
    'https://pidgin-36m.pages.dev/hero-pigeon-v3.webm#t=0.1',
  );
  for (const extension of ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'ogg', 'MP4']) {
    expect(`.${extension} is a video`, `https://cdn.example.com/clip.${extension}`, 'asset', 'video');
  }
  expect('an existing fragment is replaced', 'https://cdn.example.com/clip.mp4#t=4', 'video', 'video', 'https://cdn.example.com/clip.mp4#t=0.1');
  expect('a query survives the frame fragment', 'https://cdn.example.com/clip.mp4?v=2', 'video', 'video', 'https://cdn.example.com/clip.mp4?v=2#t=0.1');
  expect('protocol-relative video is https', '//cdn.example.com/clip.webm', 'video', 'video', 'https://cdn.example.com/clip.webm#t=0.1');
  expect('extensionless URL in a video field', 'https://stream.example.com/v/42', 'video', 'video', 'https://stream.example.com/v/42#t=0.1');
  expect('blob URL in a video field', 'blob:https://example.com/2f1c', 'video', 'video', 'blob:https://example.com/2f1c#t=0.1');

  // --- Nothing loads --------------------------------------------------------------
  expect('javascript: URL', 'javascript:alert(1)', 'image', 'unknown');
  expect('javascript: URL with odd casing', 'JaVaScRiPt:alert(1)', 'video', 'unknown');
  expect('javascript: URL behind whitespace', '  javascript:alert(1)', 'image', 'unknown');
  expect('vbscript: URL', 'vbscript:msgbox(1)', 'image', 'unknown');
  expect('file: URL', 'file:///etc/passwd.png', 'image', 'unknown');
  expect('ftp: URL', 'ftp://example.com/a.png', 'image', 'unknown');
  expect('data:text/html URL', 'data:text/html,<script>alert(1)</script>', 'image', 'unknown');
  expect('data:video URL', 'data:video/mp4;base64,AAAA', 'video', 'unknown');
  expect('data: URL without a type', 'data:,hello', 'image', 'unknown');
  expect('a root-relative path is not external', '/images/hero.png', 'image', 'unknown');
  expect('a relative path is not external', 'hero.png', 'image', 'unknown');
  expect('an empty value', '', 'image', 'unknown');
  expect('a blank value', '   ', 'image', 'unknown');
  expect('a malformed URL', 'https://', 'image', 'unknown');
  expect('an audio file', 'https://cdn.example.com/track.mp3', 'asset', 'unknown');
  expect('ogg in an audio field', 'https://cdn.example.com/track.ogg', 'audio', 'unknown');
  expect('extensionless URL in an audio field', 'https://cdn.example.com/track', 'audio', 'unknown');
  expect('blob URL in an audio field', 'blob:https://example.com/2f1c', 'audio', 'unknown');
  const oversized = `data:image/png;base64,${'A'.repeat(REMOTE_MEDIA_LIMITS.urlLengthMax)}`;
  expect('a value over the length limit', oversized, 'image', 'unknown');
  const atLimit = `https://cdn.example.com/${'a'.repeat(REMOTE_MEDIA_LIMITS.urlLengthMax - 'https://cdn.example.com/.png'.length)}.png`;
  check('a value at the length limit is exactly the limit', atLimit.length === REMOTE_MEDIA_LIMITS.urlLengthMax);
  expect('a value at the length limit still previews', atLimit, 'image', 'image');

  // --- Posters ----------------------------------------------------------------------
  check('a poster image URL is kept', remotePosterSource('https://cdn.example.com/p.jpg') === 'https://cdn.example.com/p.jpg');
  check('a protocol-relative poster is https', remotePosterSource('//cdn.example.com/p.jpg') === 'https://cdn.example.com/p.jpg');
  check('no poster is no poster', remotePosterSource(undefined) === undefined);
  check('a video is not a poster', remotePosterSource('https://cdn.example.com/p.webm') === undefined);
  check('a javascript: poster is dropped', remotePosterSource('javascript:alert(1)') === undefined);
  check('a local poster path is not remote', remotePosterSource('/poster.jpg') === undefined);

  if (failures.length) {
    console.error(`\nremoteMedia: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`remoteMedia: ${checked} passed`);
})();
