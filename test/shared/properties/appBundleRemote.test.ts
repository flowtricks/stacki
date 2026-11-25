// Goal: an app bundle that loads code from another host is refused at install
// (shared/properties/appBundle.ts findRemoteCode), with a message that names the
// file and the URL, while runtime calls, passive images, namespaces, `data:` URLs
// and the bundle's own files pass.
// Method: one known-good bundle read through readAppBundle, then each remote
// shape (HTML script and link tags, inline scripts and styles, JavaScript
// static, bare, re-exported, dynamic and worker imports, CSS @import and url())
// added to it alone; the scanner itself is also driven directly for the bound
// and the cases that must not be flagged.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { findRemoteCode, readAppBundle, remoteCodeMessage, REMOTE_CODE_LIMITS, writeStoredZip } from '#dist/shared/properties/appBundle.js';

const inflate = (data: Uint8Array, sizeBytesMax: number) => new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, sizeBytesMax) }));
const encoder = new TextEncoder();
const file = (path: string, text: string) => ({ path, bytes: encoder.encode(text) });
const MANIFEST = { manifestVersion: 1, id: 'remote-check', name: 'Remote check', version: '1.0.0', entry: 'index.html' };
const bundle = (...extra: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>) =>
  writeStoredZip([
    file('stacki-app.json', JSON.stringify(MANIFEST)),
    file('index.html', '<!doctype html><script src="stacki-sdk.js"></script><script type="module" src="app.js"></script>'),
    file('app.js', "import { draw } from './draw.js';\nawait fetch('https://analyticsdata.example.com/v1');\n"),
    ...extra,
  ]);

test('a bundle of its own files installs', () => {
  const read = readAppBundle(bundle(file('draw.js', 'export const draw = () => 1;')), inflate);
  assert.equal(read.manifest.id, 'remote-check');
});

test('each remote load is refused with its file and URL', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['page.html', '<script src="https://cdn.example.com/lib.js"></script>', 'https://cdn.example.com/lib.js'],
    ['page.html', "<script src='//cdn.example.com/lib.js'></script>", '//cdn.example.com/lib.js'],
    ['page.html', '<link rel="stylesheet" href="https://fonts.example.com/css">', 'https://fonts.example.com/css'],
    ['page.html', '<link rel=modulepreload href=http://cdn.example.com/m.js>', 'http://cdn.example.com/m.js'],
    ['page.html', '<link rel="icon" href="https://cdn.example.com/i.png">', 'https://cdn.example.com/i.png'],
    ['page.html', '<script type="module">import x from "https://esm.example.com/x";</script>', 'https://esm.example.com/x'],
    ['page.html', "<script>import('https://esm.example.com/y')</script>", 'https://esm.example.com/y'],
    ['page.html', '<style>@import "https://fonts.example.com/a.css";</style>', 'https://fonts.example.com/a.css'],
    ['page.html', '<style>body { background: url(https://img.example.com/b.png) }</style>', 'https://img.example.com/b.png'],
    ['lib.js', "import { a } from 'https://esm.example.com/a.js';", 'https://esm.example.com/a.js'],
    ['lib.js', 'import{a}from"https://esm.example.com/min.js"', 'https://esm.example.com/min.js'],
    ['lib.mjs', "import 'https://esm.example.com/side.js';", 'https://esm.example.com/side.js'],
    ['lib.js', "export * from 'https://esm.example.com/re.js';", 'https://esm.example.com/re.js'],
    ['lib.js', 'const m = await import(`//esm.example.com/dyn.js`);', '//esm.example.com/dyn.js'],
    ['worker.js', "importScripts('https://cdn.example.com/w.js');", 'https://cdn.example.com/w.js'],
    ['style.css', '@import url("https://fonts.example.com/b.css");', 'https://fonts.example.com/b.css'],
    ['style.css', "@font-face { src: url('//fonts.example.com/f.woff2') }", '//fonts.example.com/f.woff2'],
  ];
  for (const [path, text, url] of cases) {
    assert.throws(
      () => readAppBundle(bundle(file('draw.js', ''), file(path, text)), inflate),
      (error: unknown) => error instanceof Error && error.message.includes(`${path} loads`) && error.message.includes(`from ${url}: vendor it into the bundle`),
      `${path}: ${text}`,
    );
  }
});

test('runtime calls, passive content and the bundle’s own files are not remote code', () => {
  const findings = findRemoteCode([
    file(
      'index.html',
      [
        '<!doctype html><svg xmlns="http://www.w3.org/2000/svg"></svg>',
        '<a href="https://example.com/help">Help</a><img src="https://img.example.com/a.png">',
        '<img data-src="https://img.example.com/lazy.png"><script data-src="https://x.example.com/no.js" src="./app.js"></script>',
        '<!-- <script src="https://cdn.example.com/commented.js"></script> -->',
        '<link rel="stylesheet" href="styles/app.css"><script src="stacki-sdk.js"></script>',
      ].join('\n'),
    ),
    file(
      'app.js',
      [
        "const reply = await fetch('https://analyticsdata.example.com/v1:runReport');",
        "const docs = 'see https://example.com/import';",
        '/* import x from "https://cdn.example.com/commented.js"; */',
        "// import y from 'https://cdn.example.com/line.js';",
        "import { z } from './z.js';",
        "const w = new URL('https://api.example.com/');",
        'obj.import("https://cdn.example.com/method.js");',
      ].join('\n'),
    ),
    file(
      'styles/app.css',
      "body { background: url(data:image/png;base64,AAAA) } .a { background: url('../img/a.png') } /* url(https://x.example.com/c.png) */",
    ),
    file('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://img.example.com/x.png"/></svg>'),
  ]);
  assert.deepEqual(findings, []);
});

test('findings are bounded, deduplicated and summarized', () => {
  const many = Array.from({ length: REMOTE_CODE_LIMITS.findingsMax + 5 }, (_, index) => `import 'https://esm.example.com/${index}.js';`);
  const findings = findRemoteCode([file('many.js', many.join('\n')), file('again.js', "import 'https://esm.example.com/0.js';")]);
  assert.equal(findings.length, REMOTE_CODE_LIMITS.findingsMax);
  const once = findRemoteCode([file('twice.js', "import 'https://esm.example.com/a.js';\nimport('https://esm.example.com/a.js');")]);
  assert.equal(once.length, 1);
  const message = remoteCodeMessage(findings);
  assert.match(message, /^many\.js loads remote code from https:\/\/esm\.example\.com\/0\.js: vendor it into the bundle; /);
  assert.match(message, new RegExp(`and ${REMOTE_CODE_LIMITS.findingsMax - REMOTE_CODE_LIMITS.findingsShownMax} more$`));
  const long = findRemoteCode([file('long.js', `import 'https://esm.example.com/${'a'.repeat(500)}.js';`)]);
  assert.equal(long[0]?.url.length, REMOTE_CODE_LIMITS.urlCharsMax);
  assert.throws(() => remoteCodeMessage([]), /Assertion failed: A refusal names at least one finding/);
});
