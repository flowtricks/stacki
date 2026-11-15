// Goal: a blue (accent) button never turns grey. Hover and pressed stay in the accent family, and disabled stays the same blue,
// dimmed by the global button:disabled opacity, never a neutral fill. Users reported the Settings > Breakpoints Add button going grey
// on hover; the cause was the app-wide `button:hover:not(:disabled)` grey wash (controls.css), which outweighs a bare class rule such as
// `.breakpoints-add-confirm` (0,1,0 against 0,2,1). The wash skips `.primary`; every other accent button must spell out its own states.
// Method: pure source checks, no layout and no pointer, so it holds on Windows and Linux too (jsdom cannot compute :hover).
// 1. Parse every stylesheet under src/ and find each rule that fills a button with the accent (var(--accent), --accent-hover or
//    --accent-pressed). A button is a selector that names `button`, `.primary`, or a class that a <button> in a .tsx file carries.
// 2. Such a button must either carry `.primary` (the wash skips it and button.primary:hover is the brighter accent) or have its own
//    :hover rule that fills with the accent family at a specificity of at least 0,2,1.
// 3. No :hover, :active or :focus rule on the same element may fill with a neutral (a --bg-* token, --border*, white or black wash).
// 4. The shared primary variant: the tokens exist once, button.primary has hover and pressed rules that use them, the generic wash
//    keeps its `.primary` exclusion, and a rendered primary button carries the class the rules key on.
// A policy-level lint (scripts/eslintPlugin or a stylelint rule) would hold this at edit time; it needs a human's approval, so this
// test is the guard until then.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const selectorParser = require('postcss-selector-parser');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const STATE = /:(hover|active|focus-visible|focus-within|focus)\b/;
const ACCENT_FILL = /^var\(--accent(-hover|-pressed)?\)$/;
const NEUTRAL_FILL =
  /var\(--(bg|border|scrollbar)[\w-]*\)|rgba?\(\s*(255,\s*255,\s*255|0,\s*0,\s*0)|#fff\b|#ffffff\b|\bwhite\b|\bblack\b|#000\b|\btransparent\b/;
// The start screen's primary action is white on purpose (styles.css, `.welcome .actions button.primary`); it is not a blue button.
const NOT_BLUE_BY_DESIGN = [/^\.welcome\b/];

const WALK_STEPS_MAX = 100000; // A stylesheet tree is small; the cap turns a runaway walk into a crash.

function listFiles(directory, extension) {
  const found = [];
  const pending = [directory];
  for (let step = 0; pending.length > 0; step += 1) {
    assert.ok(step < WALK_STEPS_MAX, 'listFiles: walk exceeded its bound');
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.name.endsWith(extension)) {
        found.push(full);
      }
    }
  }
  return found;
}

/** Counts [ids, classes, types] over parsed nodes, skipping :where() subtrees and counting every other pseudo as written. */
function flatWeigh(nodes) {
  const total = [0, 0, 0];
  const pending = [...nodes];
  for (let step = 0; pending.length > 0; step += 1) {
    assert.ok(step < WALK_STEPS_MAX, 'flatWeigh: walk exceeded its bound');
    const node = pending.pop();
    if (node.type === 'pseudo' && node.value === ':where') {
      continue;
    }
    if (node.type === 'id') {
      total[0] += 1;
    } else if (node.type === 'class' || node.type === 'attribute' || (node.type === 'pseudo' && !node.value.startsWith('::'))) {
      total[1] += 1;
    } else if (node.type === 'tag' || node.type === 'pseudo') {
      total[2] += 1;
    }
    if (node.nodes) {
      pending.push(...node.nodes);
    }
  }
  return total;
}

/** One selector's [ids, classes, types]; :not() and :is() count their heaviest argument (one level deep, as these sheets nest them), :where() nothing. */
function weigh(selector) {
  const total = [0, 0, 0];
  const pending = [];
  selectorParser((root) => pending.push(...root.nodes)).processSync(selector);
  for (let step = 0; pending.length > 0; step += 1) {
    assert.ok(step < WALK_STEPS_MAX, 'weigh: walk exceeded its bound');
    const node = pending.pop();
    if (node.type === 'pseudo' && node.value === ':where') {
      continue;
    }
    if (node.type === 'pseudo' && (node.value === ':not' || node.value === ':is' || node.value === ':has')) {
      let heaviest = [0, 0, 0];
      for (const argument of node.nodes) {
        const parts = flatWeigh(argument.nodes);
        if (compare(parts, heaviest) > 0) {
          heaviest = parts;
        }
      }
      heaviest.forEach((value, index) => (total[index] += value));
      continue;
    }
    if (node.type === 'id') {
      total[0] += 1;
    } else if (node.type === 'class' || node.type === 'attribute' || (node.type === 'pseudo' && !node.value.startsWith('::'))) {
      total[1] += 1;
    } else if (node.type === 'tag' || node.type === 'pseudo') {
      total[2] += 1;
    }
    if (node.nodes) {
      pending.push(...node.nodes);
    }
  }
  return total;
}

/** Specificity of one selector as [ids, classes, types]. */
function specificity(selector) {
  return weigh(selector);
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function atLeast(actual, minimum) {
  return compare(actual, minimum) >= 0;
}

/** Every rule that sets a background, one entry per comma-separated selector. */
function backgroundRules() {
  const rules = [];
  for (const file of listFiles(repoPath('src'), '.css')) {
    postcss.parse(fs.readFileSync(file, 'utf8')).walkRules((rule) => {
      let value;
      rule.walkDecls(/^background(-color)?$/, (declaration) => {
        value = declaration.value.trim();
      });
      if (value !== undefined) {
        for (const selector of rule.selectors) {
          rules.push({
            file: path.relative(ROOT, file).split(path.sep).join('/'),
            line: rule.source.start.line,
            selector: selector.replace(/\s+/g, ' '),
            value,
          });
        }
      }
    });
  }
  return rules;
}

/** The classes that a <button> carries in any component, so a bare class selector can be told apart from a bar or a dot. */
function buttonClasses() {
  const classes = new Set();
  for (const file of listFiles(repoPath('src'), '.tsx')) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/<button\b[^>]{0,400}?className=(?:"([^"]*)"|\{`([^`]*)`\})/gs)) {
      const names = (match[1] ?? match[2]).replace(/\$\{[^}]*\}/g, ' ').split(/\s+/);
      // A button that also carries .primary is held by the .primary rules, so its component class is not a bare accent button.
      const carriesPrimary = names.includes('primary');
      for (const name of names) {
        if (/^[\w-]+$/.test(name) && !carriesPrimary) {
          classes.add(name);
        }
      }
    }
  }
  return classes;
}

function stripState(selector) {
  return selector
    .replace(/:(hover|active|focus-visible|focus-within|focus)\b/g, '')
    .replace(/:not\(:disabled\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function classNames(compound) {
  return [...compound.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
}

function lastCompound(selector) {
  return selector.split(/\s*[>+~]\s*|\s+/).pop();
}

const rules = backgroundRules();
const classesOnButtons = buttonClasses();
const accentButtons = rules.filter((rule) => {
  if (STATE.test(rule.selector) || !ACCENT_FILL.test(rule.value) || NOT_BLUE_BY_DESIGN.some((pattern) => pattern.test(rule.selector))) {
    return false;
  }
  const compound = lastCompound(rule.selector);
  if (/(^|[^\w-])button\b/.test(compound) || compound.includes('.primary')) {
    return true;
  }
  const names = [...compound.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
  return names.some((name) => classesOnButtons.has(name)) && !/::/.test(compound);
});

test('the guard finds the accent buttons it is meant to hold', () => {
  const found = new Set(accentButtons.map((rule) => rule.selector));
  for (const expected of ['button.primary', '.ai-primary', '.ai-send', '.audits-card-button', '.apps-button.primary']) {
    assert.ok(found.has(expected), `${expected} is recognised as an accent button`);
  }
  assert.ok(accentButtons.length >= 8, 'the scan is not empty');
});

test('every accent button keeps the accent on hover: .primary, or its own accent hover rule', () => {
  const problems = [];
  for (const button of accentButtons) {
    if (/\.primary\b/.test(lastCompound(button.selector))) {
      continue; // The generic wash skips .primary; test 4 pins that exclusion.
    }
    const wanted = classNames(lastCompound(button.selector));
    const hovers = rules.filter((rule) => {
      if (!/:hover\b/.test(rule.selector) || !ACCENT_FILL.test(rule.value)) {
        return false;
      }
      const have = classNames(lastCompound(rule.selector));
      return wanted.every((name) => have.includes(name));
    });
    const strong = hovers.filter((rule) => atLeast(specificity(rule.selector), [0, 2, 1]));
    if (strong.length === 0) {
      problems.push(`${button.file}:${button.line} ${button.selector}: no accent :hover rule outweighing button:hover:not(:disabled)`);
    }
  }
  assert.deepEqual(problems, []);
});

test('no hover, pressed or focus rule on an accent button fills with a neutral', () => {
  const problems = [];
  const bases = new Set(accentButtons.map((rule) => stripState(rule.selector)));
  for (const rule of rules) {
    if (STATE.test(rule.selector) && bases.has(stripState(rule.selector)) && !ACCENT_FILL.test(rule.value) && NEUTRAL_FILL.test(rule.value)) {
      problems.push(`${rule.file}:${rule.line} ${rule.selector} => ${rule.value}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('no .primary button changes to a non-accent fill on hover, pressed or focus', () => {
  const problems = [];
  for (const rule of rules) {
    const compound = lastCompound(rule.selector);
    if (STATE.test(rule.selector) && compound.includes('.primary') && !compound.includes(':not(.primary') && !ACCENT_FILL.test(rule.value)) {
      if (!NOT_BLUE_BY_DESIGN.some((pattern) => pattern.test(rule.selector))) {
        problems.push(`${rule.file}:${rule.line} ${rule.selector} => ${rule.value}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('the accent tokens exist once and the shared primary variant uses them for every state', () => {
  const styles = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  for (const token of ['--accent', '--accent-hover', '--accent-pressed']) {
    assert.equal(styles.match(new RegExp(`^\\s*${token}:`, 'gm')).length, 1, `${token} is defined once`);
  }
  const controls = fs.readFileSync(repoPath('src/ui/controls.css'), 'utf8');
  const find = (selector) => rules.find((rule) => rule.file === 'src/ui/controls.css' && rule.selector === selector);
  assert.equal(find('button.primary').value, 'var(--accent)');
  assert.equal(find('button.primary:hover:not(:disabled)').value, 'var(--accent-hover)');
  assert.equal(find('button.primary:active:not(:disabled)').value, 'var(--accent-pressed)');
  assert.match(controls, /button:hover:not\(:disabled\):where\(:not\(\.primary\b/, 'the generic grey wash skips .primary');
  assert.doesNotMatch(controls, /button\.primary:disabled[^{]*\{[^}]*background/, 'a disabled primary is dimmed, not repainted grey');
});

test('rendered shared controls carry the classes the accent rules key on', () => {
  const esbuild = require('esbuild');
  const output = repoPath('node_modules/.stacki-test/accent-button-states.cjs');
  esbuild.buildSync({
    stdin: {
      contents: "export { default as SplitButton } from './src/ui/SplitButton'; export { Switch } from './src/ui/Switch';",
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server'],
    logLevel: 'silent',
  });
  const { SplitButton, Switch } = require(output);
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const split = renderToStaticMarkup(
    React.createElement(SplitButton, { className: 'primary', label: 'Log in', menuTitle: 'More', items: [{ label: 'Other', onSelect() {} }], onClick() {} }),
  );
  const tags = [...split.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
  assert.equal(tags.length, 2, 'main half and chevron half');
  for (const tag of tags) {
    assert.match(tag, /class="[^"]*\bprimary\b/, 'both halves of a primary split button carry .primary, so the grey wash skips them');
  }
  // An "on" switch is filled by a token on [aria-checked], and its hover keeps that track.
  const on = renderToStaticMarkup(React.createElement(Switch, { label: 'Allow', checked: true, onToggle() {} }));
  assert.match(on, /class="ui-switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*class="ui-switch"/);
  const hover = rules.find((rule) => rule.selector === 'button.ui-switch:hover:not(:disabled)');
  assert.equal(hover.value, 'var(--ui-switch-track)', 'a hovered switch keeps its track fill, accent when on');
});
