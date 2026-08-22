// Everything the app asks for, against everything that answers.
//
//   node test/bridge.js
//
// Two wirings, one failure mode. The renderer reaches the main process through
// `window.avb`, and it hands its panels their callbacks as props; either one
// can be misspelled, renamed or attached to the wrong thing, and nothing says
// so. A prop passed to a panel that never destructures it is the same silence
// as a missing bridge method: the button is there, the handler runs, and it
// lands in a component that was never listening. Typing a class in the style
// panel did nothing for exactly that reason — `onAddClass` was on <AssetsPanel>.
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
// A handler counts wherever it is registered, as long as the main process
// loads the module that registers it — the terminal keeps its own (and its
// pty bookkeeping) in electron/terminal.js rather than in main.js.
const mainSide = [main];
for (const m of main.matchAll(/require\(\s*'\.\/([\w.-]+?)(?:\.js)?'\s*\)/g)) {
  try {
    mainSide.push(fs.readFileSync(path.join(root, 'electron', `${m[1]}.js`), 'utf8'));
  } catch {
    /* not a file of ours */
  }
}
for (const text of mainSide) {
  for (const m of text.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)) handled.add(m[1]);
}

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

// --- what the app hands its panels ------------------------------------------
// A prop is only wired if the component takes it. Components that spread the
// rest of their props (`{...ctx}`) forward what they aren't named, so they are
// not checked; nor is anything whose props aren't destructured in its
// signature, which is what "declared" means here.
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');

// The props an opening tag passes, read by walking to the end of the tag so a
// value containing `>` (an arrow function, a comparison) doesn't end it early.
const propsPassed = (text, from) => {
  let depth = 0;
  let quote = null;
  let head = '';
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && (c === '>' || (c === '/' && text[i + 1] === '>'))) break;
    if (depth === 0) head += c;
  }
  return [...head.matchAll(/(?:^|\s)([a-zA-Z_$][\w$]*)=/g)].map((m) => m[1]);
};

// The props a component destructures in its signature, or null when it takes
// them whole (or forwards a rest).
const propsDeclared = (base) => {
  for (const ext of ['.jsx', '.tsx', '.js', '.ts', '']) {
    const file = base + ext;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    const m =
      text.match(/export default function\s+[\w$]*\s*\(\s*\{([\s\S]*?)\}\s*\)/) ||
      text.match(/function\s+[\w$]+\(\s*\{([\s\S]*?)\}\s*\)\s*\{/);
    if (!m || m[1].includes('...')) return null;
    return new Set([...m[1].matchAll(/(?:^|,|\s)([a-zA-Z_$][\w$]*)\s*(?=[,:=}]|$)/g)].map((x) => x[1]));
  }
  return null;
};

let wired = 0;
for (const file of sources) {
  if (!/\.(jsx|tsx)$/.test(file)) continue;
  const text = stripComments(fs.readFileSync(file, 'utf8'));
  const imported = new Map();
  for (const m of text.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+'(\.[^']+)';/gm)) {
    imported.set(m[1], path.resolve(path.dirname(file), m[2]));
  }
  for (const m of text.matchAll(/<([A-Z][\w$]*)[\s>]/g)) {
    const target = imported.get(m[1]);
    if (!target) continue;
    const declared = propsDeclared(target);
    if (!declared) continue;
    const where = `${path.relative(root, file)}:${text.slice(0, m.index).split('\n').length}`;
    for (const prop of propsPassed(text, m.index + m[0].length - 1)) {
      if (prop === 'key' || prop === 'ref') continue;
      wired++;
      check(
        `<${m[1]} ${prop}> is a prop it takes`,
        declared.has(prop),
        `${where} passes ${prop}, which ${path.relative(root, target)} never reads — it goes nowhere`
      );
    }
  }
}
check('the panels are wired to something', wired > 100, `${wired} props`);

if (failures.length) {
  console.error(`\nbridge: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(
  `bridge: ${checked} passed  [${used.size} methods called, ${exposed.size} exposed, ${wired} props wired]`
);
