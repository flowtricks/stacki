// Goal: an Astro file declares variables, so a change to one reaches the Variables
// panel however it was written: an outside edit also reloads the page, and the app's
// own save refreshes the panel without reloading what it just wrote.
// Method: the real watcher runs on a scripted `fs.watch`, each event alone, so one
// channel cannot stand in for another; debounces settle before the channels are read.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { watchProject } = require('#dist/electron/project/projectWatcher.js');

test('The panel hears a change to an Astro file, however it was written', async (context) => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-astro-variable-watch-'));
  fs.mkdirSync(path.join(projectPath, 'src'));
  context.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
  const sent = [];
  const handlers = new Map();
  const watcher = watchProject({
    projectPath,
    send: (channel) => sent.push(channel),
    isSelfWrite: (file) => file.endsWith('ours.astro'),
    noteExternalChange: () => {},
    notePageMayHaveChanged: () => {},
    scheduleThumb: () => {},
    mediaPattern: /\.png$/,
    watch: (directory, _options, handler) => {
      handlers.set(path.basename(directory), handler);
      return { close: () => {} };
    },
  });
  context.after(() => watcher.close());
  const channels = async (name) => {
    sent.length = 0;
    handlers.get('src')('change', name);
    await delay(250);
    return [...sent].filter((channel) => channel !== 'page:maybe-changed').sort();
  };
  assert.deepEqual(await channels('pages/theirs.astro'), ['css:changed', 'fs:changed'], 'an outside edit refreshes the page and the panel');
  assert.deepEqual(await channels('pages/ours.astro'), ['css:changed'], 'an app save refreshes the panel and does not reload the page');
  assert.deepEqual(await channels('pages/data.ts'), [], 'other source files declare no variables');
});
