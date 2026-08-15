// Everything the app asks the main process for, against everything the preload
// actually offers.
//
//   node test/bridge.js
//
// The renderer reaches the main process through one object — `window.avb`,
// assembled in electron/preload.js — and a call to something that is not on it
// fails the way a missing feature does: an async handler throws into nothing,
// the button does nothing, and no error appears anywhere. The same shape of
// silence covers a typo, a rename, and a method whose IPC handler was never
// registered.
//
// So the three lists are compared here: what the renderer calls, what the
// preload exposes, and what main.js handles.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const walk = (dir, test, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, test, out);
    else if (test(entry.name)) out.push(full);
  }
  return out;
};

// --- what the renderer calls ------------------------------------------------
const sources = walk(path.join(root, 'src'), (name) => /\.(jsx?|tsx?)$/.test(name));
const used = new Map(); // method -> [files]
for (const file of sources) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/window\.avb\??\.([A-Za-z_$][\w$]*)/g)) {
    if (!used.has(m[1])) used.set(m[1], []);
    const where = path.relative(root, file);
    if (!used.get(m[1]).includes(where)) used.get(m[1]).push(where);
  }
  // `window.avb?.[name]` with a variable name cannot be checked statically —
  // the sheet's own guarded caller is the one place that does it, and it
  // reports a missing method itself.
}

// --- what the preload exposes -----------------------------------------------
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
const exposed = new Set();
const bridgeStart = preload.indexOf('contextBridge.exposeInMainWorld');
const bridgeText = preload.slice(bridgeStart);
for (const m of bridgeText.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)) exposed.add(m[1]);

// --- what the main process handles ------------------------------------------
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const handled = new Set();
for (const m of main.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)) handled.add(m[1]);

// The channel each exposed method invokes, so a method that is exposed but has
// no handler is caught too — that fails at runtime with "no handler registered".
const channels = new Map();
for (const m of bridgeText.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:\s*invoke\(\s*['"]([^'"]+)['"]/gm)) {
  channels.set(m[1], m[2]);
}

check('the preload exposes something', exposed.size > 20, `${exposed.size}`);
check('the renderer calls something', used.size > 20, `${used.size}`);

for (const [method, files] of [...used].sort()) {
  check(
    `window.avb.${method} exists on the bridge`,
    exposed.has(method),
    `called from ${files.join(', ')} — add it to electron/preload.js`
  );
}

for (const [method, channel] of [...channels].sort()) {
  check(
    `${method} has a handler for ${channel}`,
    handled.has(channel),
    `electron/preload.js invokes '${channel}', which no ipcMain.handle registers`
  );
}

if (failures.length) {
  console.error(`\nbridge: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`bridge: ${checked} passed  [${used.size} methods called, ${exposed.size} exposed]`);
