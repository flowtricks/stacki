// Goal: real image conversion updates references without losing original assets.
// Method: encode both formats in isolated projects, inspect decoded size, and
// exercise name collisions, invalid bytes, symlinks and portable codec packaging.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { convertImage } = require('#dist/electron/project/imageConversion.js');
const { rewriteImageReferences } = require('#dist/electron/project/imageReferences.js');
const { parseImagePath, parseImageFormat } = require('#dist/shared/ipc/assetConversion.js');

const picture = () =>
  sharp({
    create: { width: 100, height: 80, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
  })
    .png()
    .toBuffer();

test('both image formats update references before trashing the original', async () => {
  for (const format of ['webp', 'avif']) {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-images-'));
    try {
      fs.mkdirSync(path.join(projectPath, 'public/img'), { recursive: true });
      fs.mkdirSync(path.join(projectPath, 'src/pages'), { recursive: true });
      const original = path.join(projectPath, 'public/img/photo.png');
      fs.writeFileSync(original, await picture());
      const page = path.join(projectPath, 'src/pages/index.astro');
      fs.writeFileSync(page, '<img src="/img/photo.png?width=80" />\n' + '<style>img{background:url(/img/photo.png)}</style>\n');
      const trashed = [];
      const result = await convertImage({
        projectPath,
        rel: 'public/img/photo.png',
        format,
        trash: async (file) => {
          trashed.push(file);
          fs.renameSync(file, file + '.trash');
        },
      });
      assert.equal(result.ok, true, result.error);
      const output = path.join(projectPath, `public/img/photo.${format}`);
      // Read bytes so native codec caching cannot hold a Windows file handle.
      const metadata = await sharp(fs.readFileSync(output)).metadata();
      assert.equal(metadata.width, 95);
      assert.equal(metadata.height, 76);
      assert.equal(metadata.format, format === 'avif' ? 'heif' : format);
      assert.equal(metadata.hasAlpha, true);
      assert.deepEqual(trashed, [original]);
      assert.equal(fs.existsSync(original), false);
      assert.match(fs.readFileSync(page, 'utf8'), new RegExp(`/img/photo\\.${format}\\?width=80`));
      assert.equal(fs.readFileSync(page, 'utf8').includes('.png'), false);
    } finally {
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
  }
});

test('collisions and invalid input keep files and references untouched', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-images-'));
  try {
    fs.mkdirSync(path.join(projectPath, 'public'));
    const original = path.join(projectPath, 'public/photo.png');
    const target = path.join(projectPath, 'public/photo.webp');
    fs.writeFileSync(original, 'not an image');
    fs.writeFileSync(target, 'existing output');
    const options = {
      projectPath,
      rel: 'public/photo.png',
      format: 'webp',
      trash: async () => {
        assert.fail('Original must survive');
      },
    };
    assert.equal((await convertImage(options)).ok, false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'existing output');
    fs.unlinkSync(target);
    assert.equal((await convertImage(options)).ok, false);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readFileSync(original, 'utf8'), 'not an image');
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('relative collection paths, aliases, encoded URLs and suffixes rewrite precisely', () => {
  const root = path.resolve('/project');
  const from = path.join(root, 'src/assets/my photo.png');
  const to = path.join(root, 'src/assets/my photo.avif');
  const file = path.join(root, 'src/content/post.md');
  const before = '---\nimage: ../assets/my%20photo.png\n---\n![Photo](../assets/my%20photo.png)\n';
  assert.equal(rewriteImageReferences(before, file, root, from, to), before.replaceAll('.png', '.avif'));
  assert.equal(
    rewriteImageReferences("import image from '@/assets/my photo.png';", file, root, from, to, [['@/', ['src/']]]),
    "import image from '@/assets/my photo.avif';",
  );
  const publicFrom = path.join(root, 'public/photo.png');
  const publicTo = path.join(root, 'public/photo.webp');
  const source = '<img src=/photo.png><img src="https://remote.test/photo.png"><img src="/photo.png.backup">';
  assert.equal(rewriteImageReferences(source, file, root, publicFrom, publicTo), source.replace('src=/photo.png>', 'src=/photo.webp>'));
  for (const value of ['../photo.png', 'src/../photo.png', 'public/a.svg', 'public/a.gif', 'public/./a.png']) {
    assert.throws(() => parseImagePath(value));
  }
  assert.throws(() => parseImageFormat('png'));
});

test('portable codec encodes both formats without architecture-specific packages', () => {
  const { spawnSync } = require('node:child_process');
  const script = `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function(name, ...args) {
      if (name.startsWith('@img/sharp-') && !name.startsWith('@img/sharp-wasm32')) {
        throw new Error('Native codec unavailable in this packaging test');
      }
      return load.call(this, name, ...args);
    };
    const sharp = require('sharp');
    (async () => {
      for (const format of ['webp', 'avif']) {
        const data = await sharp({ create: { width: 10, height: 10, channels: 3,
          background: 'red' } }).toFormat(format, { quality: 95, effort: 2 }).toBuffer();
        const metadata = await sharp(data).metadata();
        if (metadata.width !== 10) throw new Error('Invalid output');
      }
      process.stdout.write('portable codecs passed');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /portable codecs passed/);
});

test('linked files outside the project never reach encoding or deletion', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-images-link-'));
  try {
    const projectPath = path.join(directory, 'project');
    fs.mkdirSync(path.join(projectPath, 'public'), { recursive: true });
    const outside = path.join(directory, 'outside.png');
    fs.writeFileSync(outside, await picture());
    if (process.platform === 'win32') {
      return;
    }
    fs.symlinkSync(outside, path.join(projectPath, 'public/photo.png'));
    const result = await convertImage({
      projectPath,
      rel: 'public/photo.png',
      format: 'webp',
      trash: async () => {
        assert.fail('Outside file must not be deleted');
      },
    });
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(outside), true);
    assert.equal(fs.existsSync(path.join(projectPath, 'public/photo.webp')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a concurrent document edit rolls back earlier references and keeps both images', async () => {
  const { DocumentActors, createNodeDocumentActors } = require('#dist/electron/documents/documentActors.js');
  const { NODE_PROJECTOR, NodeDocumentDisk } = require('#dist/electron/documents/documentDisk.js');
  const { createDocumentTelemetry } = require('#dist/electron/documents/documentTelemetry.js');
  const { installDocumentHost } = require('#dist/electron/documents/documentWrites.js');
  const { planIntent } = require('#dist/shared/engine/planner.js');
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-images-race-'));
  try {
    fs.mkdirSync(path.join(projectPath, 'public'));
    const original = path.join(projectPath, 'public/photo.png');
    fs.writeFileSync(original, await picture());
    const first = path.join(projectPath, 'a.astro');
    const second = path.join(projectPath, 'b.astro');
    const before = '<img src="/photo.png" />';
    fs.writeFileSync(first, before);
    fs.writeFileSync(second, before);
    installDocumentHost({
      noteWrite() {},
      documents: new DocumentActors({
        disk: new NodeDocumentDisk(),
        projector: NODE_PROJECTOR,
        planner: planIntent,
        telemetry: createDocumentTelemetry(() => {}),
        drain: 'immediate',
        schedule: setImmediate,
        onLease(file) {
          if (file.endsWith('b.astro')) {
            fs.writeFileSync(file, before + '<p>External edit</p>');
          }
        },
      }),
    });
    const result = await convertImage({
      projectPath,
      rel: 'public/photo.png',
      format: 'webp',
      trash: async () => {
        assert.fail('Original must survive a reference conflict');
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /Both images were kept/);
    assert.equal(fs.readFileSync(first, 'utf8'), before);
    assert.equal(fs.readFileSync(second, 'utf8'), before + '<p>External edit</p>');
    assert.equal(fs.existsSync(original), true);
    assert.equal(fs.existsSync(path.join(projectPath, 'public/photo.webp')), true);
  } finally {
    installDocumentHost({
      noteWrite() {},
      documents: createNodeDocumentActors({ log() {}, schedule: setImmediate }),
    });
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
