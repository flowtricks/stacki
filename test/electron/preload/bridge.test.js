// Everything the app asks for, against everything that answers.
//
//   node test/electron/preload/bridge.test.js
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
// assembled in electron/preload/preloadBridge.ts — and a call to something that is not on it
// fails the way a missing feature does: an async handler throws into nothing,
// the button does nothing, and no error appears anywhere. The same shape of
// silence covers a typo, a rename, and a method whose IPC handler was never
// registered.
//
// So the three lists are compared here: what the renderer calls, what the
// preload exposes, and what main.js handles.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const root = ROOT;
const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

// A walk of a project's folders stops at this depth: real source trees are a few folders
// deep, so anything deeper is a loop or a runaway, not a project.
const WALK_LIMITS = { directoryDepthMax: 32 };
const walk = (directory, test, out = [], depth = 0) => {
  assert.ok(depth <= WALK_LIMITS.directoryDepthMax, 'walk: directory depth limit');
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(full, test, out, depth + 1);
    } else if (test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

// --- what the renderer calls ------------------------------------------------
const sources = walk(repoPath('src'), (name) => /\.(jsx?|tsx?)$/.test(name));
const used = new Map(); // method -> [files]
for (const file of sources) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/window\.avb\??\.([A-Za-z_$][\w$]*)/g)) {
    if (!used.has(match[1])) {
      used.set(match[1], []);
    }
    const where = path.relative(root, file);
    if (!used.get(match[1]).includes(where)) {
      used.get(match[1]).push(where);
    }
  }
  // `window.avb?.[name]` with a variable name cannot be checked statically —
  // the sheet's own guarded caller is the one place that does it, and it
  // reports a missing method itself.
}

// --- what the preload exposes -----------------------------------------------
// The module that builds window.avb, and nothing else: its sections and the
// call that exposes them (the shipped preload is a bundle of it and the frame
// modules, in whatever order the bundler chose).
const exposed = new Set();
const bridgeText = fs.readFileSync(repoPath('electron/preload/preloadBridge.ts'), 'utf8');
for (const match of bridgeText.matchAll(/^\s+([A-Za-z_$][\w$]*)\s*:/gm)) {
  exposed.add(match[1]);
}

// --- what the main process handles ------------------------------------------
const main = fs.readFileSync(repoPath('dist/electron/main.js'), 'utf8');
const handled = new Set();
// A handler counts wherever it is registered, as long as the main process
// loads the module that registers it — the terminal keeps its own (and its
// pty bookkeeping) in electron/terminal/terminal.ts rather than in main.js.
const mainSide = [main];
// Modules live in area folders (`./terminal/terminal`), so a match spans folders.
for (const match of main.matchAll(/require\(\s*['"]\.\/([\w./-]+?)(?:\.js)?['"]\s*\)/g)) {
  try {
    mainSide.push(fs.readFileSync(path.join(root, 'dist', 'electron', `${match[1]}.js`), 'utf8'));
  } catch {
    /* not a file of ours */
  }
}
for (const text of mainSide) {
  for (const match of text.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)) {
    handled.add(match[1]);
  }
}

// The channel each exposed method invokes, so a method that is exposed but has
// no handler is caught too — that fails at runtime with "no handler registered".
const channels = new Map();
for (const match of bridgeText.matchAll(/^\s+([A-Za-z_$][\w$]*)\s*:\s*invoke\(\s*['"]([^'"]+)['"]/gm)) {
  channels.set(match[1], match[2]);
}

check('the preload exposes something', exposed.size > 20, `${exposed.size}`);
check('the renderer calls something', used.size > 20, `${used.size}`);

for (const [method, files] of [...used].sort()) {
  check(`window.avb.${method} exists on the bridge`, exposed.has(method), `called from ${files.join(', ')} — add it to electron/preload/preloadBridge.ts`);
}

for (const [method, channel] of [...channels].sort()) {
  check(
    `${method} has a handler for ${channel}`,
    handled.has(channel),
    `electron/preload/preloadBridge.ts invokes '${channel}', which no ipcMain.handle registers`,
  );
}

// --- what the app hands its panels ------------------------------------------
// A prop is only wired if the component takes it. Components that spread the
// rest of their props (`{...ctx}`) forward what they aren't named, so they are
// not checked; nor is anything whose props aren't destructured in its
// signature, which is what "declared" means here.
// A block comment keeps its line breaks, so a reported line number is the
// line in the file rather than the line in the stripped text.
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');

// The props an opening tag passes, read by walking to the end of the tag so a
// value containing `>` (an arrow function, a comparison) doesn't end it early.
const propsPassed = (text, from) => {
  let depth = 0;
  let quote;
  let head = '';
  for (let i = from; i < text.length; i++) {
    const character = text[i];
    if (quote) {
      if (character === quote && text[i - 1] !== '\\') {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') {
      depth++;
    } else if (character === '}') {
      depth--;
    } else if (depth === 0 && (character === '>' || (character === '/' && text[i + 1] === '>'))) {
      break;
    }
    if (depth === 0) {
      head += character;
    }
  }
  return [...head.matchAll(/(?:^|\s)([a-zA-Z_$][\w$]*)=/g)].map((match) => match[1]);
};

// The props a component destructures in its signature, or undefined when it takes
// them whole (or forwards a rest).
const propsDeclared = (base) => {
  for (const ext of ['.jsx', '.tsx', '.js', '.ts', '']) {
    const file = base + ext;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      continue;
    }
    // Parse the exported component itself. A regex can drift into a private
    // hook's destructuring when the component accepts a typed props object.
    const ts = require('typescript');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = bridgeComponent(ts, source);
    const binding = declaration?.parameters[0]?.name;
    if (!binding) {
      return undefined;
    }
    if (!ts.isObjectBindingPattern(binding)) {
      // A local props interface is just as explicit as destructuring. Preserve
      // this boundary check when conversion moves a component to a typed object.
      const parameterType = declaration.parameters[0].type;
      if (!parameterType || !ts.isTypeReferenceNode(parameterType)) {
        return undefined;
      }
      const name = parameterType.typeName.getText(source);
      const contract = source.statements.find((node) => ts.isInterfaceDeclaration(node) && node.name.text === name);
      if (!contract || contract.heritageClauses?.length) {
        return undefined;
      }
      if (contract.members.some((member) => !ts.isPropertySignature(member))) {
        return undefined;
      }
      return new Set(contract.members.map((member) => member.name.getText(source)));
    }
    if (binding.elements.some((element) => element.dotDotDotToken)) {
      return undefined;
    }
    return new Set(binding.elements.map((element) => (element.propertyName || element.name).getText(source)));
  }
  return undefined;
};

function bridgeComponent(ts, source) {
  const direct = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
  );
  if (direct) {
    return direct;
  }
  const assignment = source.statements.find((node) => ts.isExportAssignment(node));
  if (!assignment) {
    return undefined;
  }
  let expression = assignment.expression;
  if (ts.isIdentifier(expression)) {
    const name = expression.text;
    const named = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (named) {
      return named;
    }
    const variables = source.statements.filter(ts.isVariableStatement).flatMap((node) => [...node.declarationList.declarations]);
    expression = variables.find((node) => node.name.getText(source) === name)?.initializer;
  }
  // React wrappers take the component as a direct argument; do not inspect
  // unrelated function bodies for a parameter that happens to look like props.
  if (expression && ts.isCallExpression(expression)) {
    expression = expression.arguments.find((node) => ts.isFunctionExpression(node) || ts.isArrowFunction(node));
  }
  return expression && (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) ? expression : undefined;
}

let wired = 0;
for (const file of sources) {
  if (!/\.(jsx|tsx)$/.test(file)) {
    continue;
  }
  const text = stripComments(fs.readFileSync(file, 'utf8'));
  const imported = new Map();
  // The semicolon is optional: a file written without them imports the same
  // component, and requiring one silently skipped every such file.
  for (const match of text.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s+from\s+'(\.[^']+)';?/gm)) {
    imported.set(match[1], path.resolve(path.dirname(file), match[2]));
  }
  // Lazy-loading changes when a panel loads, not its prop contract. Follow
  // those module references too so startup optimization cannot erase coverage.
  for (const match of text.matchAll(
    new RegExp(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:React\.)?lazy(?:Panel)?/.source + /\(\s*\(\s*\)\s*=>\s*import\(\s*['"](\.[^'"]+)['"]\s*\)/.source, 'g'),
  )) {
    imported.set(match[1], path.resolve(path.dirname(file), match[2]));
  }
  for (const match of text.matchAll(/<([A-Z][\w$]*)[\s>]/g)) {
    const target = imported.get(match[1]);
    if (!target) {
      continue;
    }
    const declared = propsDeclared(target);
    if (!declared) {
      continue;
    }
    const where = `${path.relative(root, file)}:${text.slice(0, match.index).split('\n').length}`;
    for (const prop of propsPassed(text, match.index + match[0].length - 1)) {
      if (prop === 'key' || prop === 'ref') {
        continue;
      }
      wired++;
      check(
        `<${match[1]} ${prop}> is a prop it takes`,
        declared.has(prop),
        `${where} passes ${prop}, which ${path.relative(root, target)} never reads — it goes ` + `nowhere`,
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
console.log(`bridge: ${checked} passed  [${used.size} methods called, ${exposed.size} exposed,` + ` ${wired} props wired]`);
