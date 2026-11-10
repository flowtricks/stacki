// Goal: replacing an asset swaps its bytes in place only for files that are assets — anything
// under public/, and media under src/ — never the code under src/ (pages, components,
// stylesheets), which only the document actors write (test/electron/documents/singleWriter.test.ts
// allows the raw copy on exactly that condition).
// Method: register the real handlers against a recording ipcMain and a temporary project, answer
// the file dialog with a prepared replacement, and check what the handler returns and what is on
// disk afterwards — for a src/ stylesheet (refused before the dialog opens), a src/ image and a
// public/ file (both replaced), and a replacement of another media kind (refused, file unchanged).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerAssetHandlers } = require('#dist/electron/handlers/assetHandlers.js');

function setup() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-asset-replace-'));
  const write = (rel, text) => {
    const file = path.join(project, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  write('src/styles/global.css', 'body { color: red; }');
  write('src/images/hero.png', 'old png');
  write('public/robots.txt', 'old robots');
  const handlers = new Map();
  const dialogs = [];
  let picked = '';
  registerAssetHandlers({
    assertInProject: () => {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    noteAppWrite: () => {},
    send: () => {},
    shell: { trashItem: async () => {} },
    showOpenDialog: async (options) => {
      dialogs.push(options);
      return { canceled: false, filePaths: [picked] };
    },
  });
  const replace = handlers.get('assets:replace');
  assert.equal(typeof replace, 'function');
  return {
    project,
    dialogs,
    pick: (name, text) => {
      picked = write(`../${path.basename(project)}-picked/${name}`, text);
    },
    replace: (rel) => replace({}, { projectPath: project, rel }),
    read: (rel) => fs.readFileSync(path.join(project, rel), 'utf8'),
    cleanup: () => {
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(`${project}-picked`, { recursive: true, force: true });
    },
  };
}

test('code under src/ is refused before any dialog or write', async () => {
  const fixture = setup();
  try {
    fixture.pick('other.css', 'body { color: blue; }');
    const result = await fixture.replace('src/styles/global.css');
    assert.equal(result.ok, false);
    assert.match(result.message, /global\.css is source code, not an asset/);
    assert.equal(fixture.dialogs.length, 0, 'no file dialog for a refused target');
    assert.equal(fixture.read('src/styles/global.css'), 'body { color: red; }');
  } finally {
    fixture.cleanup();
  }
});

test('media under src/ and any file under public/ are replaced in place', async () => {
  const fixture = setup();
  try {
    fixture.pick('new.png', 'new png');
    assert.deepEqual(await fixture.replace('src/images/hero.png'), { ok: true, value: true });
    assert.equal(fixture.read('src/images/hero.png'), 'new png');
    fixture.pick('other.txt', 'new robots');
    assert.deepEqual(await fixture.replace('public/robots.txt'), { ok: true, value: true });
    assert.equal(fixture.read('public/robots.txt'), 'new robots');
  } finally {
    fixture.cleanup();
  }
});

test('a replacement of another media kind is refused and leaves the file', async () => {
  const fixture = setup();
  try {
    fixture.pick('clip.mp4', 'video');
    const result = await fixture.replace('src/images/hero.png');
    assert.equal(result.ok, false);
    assert.match(result.message, /an image/);
    assert.equal(fixture.read('src/images/hero.png'), 'old png');
  } finally {
    fixture.cleanup();
  }
});
