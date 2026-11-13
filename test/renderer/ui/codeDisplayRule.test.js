// Goal: code anywhere in the app is syntax highlighted (AGENTS.md, "Code
// display"). A new dialog that drops generated source into a plain <pre> is the
// bug this exists to stop: it looks fine, nothing fails, and the code is grey.
// Method: a source scan over both apps, in the manner of codeVariables.test.js.
// Colouring needs one of the shared components, so a plain <pre>, a plain <code>
// or a monospace style set in a component is a finding, and so is a stylesheet
// rule that makes an element a code block: monospace on a pre or a textarea, or
// monospace with preserved white space on anything. The line is drawn by the
// lists below, which name what is not code and say why. Every entry is checked
// to still match, so one cannot outlive its reason. That a converted site really
// shows tokens is codeBlock.test.js's job, not this scan's.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const SOURCE_ROOTS = ['src', 'studio/src'];

// The shared components: a plain element or a theme inside one of these is how the rule is met.
const SHARED_COMPONENTS = new Set(['src/ui/CodeBlock.tsx', 'src/ui/CodeEditor.tsx']);

// A <pre> that is not plain code, by what it holds.
const PRE_ALLOWED = {
  'src/features/ai/SignInCard.tsx': 'Log: the agent’s own words about a failed sign-in, behind Details, which are not code.',
  'src/features/ai/transcript/ErrorRow.tsx': 'Log: the agent’s own error message for a reply that did not finish, behind Details, which is not code.',
  'src/features/studioSetup/InstallProgress.tsx': 'Log: the output of the Studio installer, which is not code.',
  'src/features/style/embed/QueryForms.tsx': 'Highlighted already: CssCodePreview colours its lines with cssTokens and marks overridden ones.',
  'src/features/welcome/WelcomeWizards.tsx': 'Log: the output of a project being created, which is not code.',
};

// A <code> holding a name in a sentence or a chip: a selector, a path, a key, a
// single declaration in a hint. It is a label, not code to read. A shell command
// is code wherever it sits, and takes CodeInline.
const CODE_LABELS_ALLOWED = {
  'src/app/settings/InstructionsSettings.tsx': 'A path pattern in a sentence or a list row.',
  'src/features/assets/AssetsPanel.tsx': 'A folder name in a sentence.',
  'src/features/cms/CmsSettings.tsx': 'A field key in a sentence.',
  'src/features/palette/PaletteDialogs.tsx': 'A component name and its path in a sentence.',
  'src/features/palette/PalettePanel.tsx': 'A folder name in a sentence.',
  'src/features/props/ConditionalValue.tsx': 'Highlighted already: a style value is coloured with declarationTokens through CodeTokens, between value chips.',
  'src/features/props/LinkField.tsx': 'The attribute name `id` in a sentence.',
  'src/features/selectors/SelectorsPanel.tsx': 'A selector chip, with the names its verdict is about marked.',
  'src/features/structure/StructurePanel.tsx': 'The integration a route comes from, in a sentence.',
  'src/features/style/DirectionControl.tsx': 'A hover hint naming one declaration per line.',
  'src/features/style/ProvenanceList.tsx': 'A selector chip.',
  'src/features/style/components/InheritedPropertyLabel.tsx': 'A selector chip.',
  'src/features/style/embed/ResolvedRows.tsx': 'A property name heading a popup.',
  'studio/src/features/ai/ChatText.tsx': 'Inline Markdown code in a chat message: a word in a sentence, with no language to read. Fences take CodeBlock.',
  'studio/src/features/github/SyncNotice.tsx': 'A file path in a list.',
};

// Stylesheet rules that look like a code block and are not one.
const STYLE_ALLOWED = {
  '.create-log': 'Log: the <pre> of a project being created.',
  '.embed-editor_css-code-preview': 'Highlighted already: the element CssCodePreview draws.',
  '.html-content pre': 'Rich text: a block in the content being written, drawn as that content.',
  '.studio-install-output': 'Log: the <pre> of the Studio installer.',
  '.studio-setup-details textarea': 'Prose: instructions for an agent, to read and copy, not code.',
};

function sourceFiles(extension) {
  const found = [];
  const pending = SOURCE_ROOTS.map((root) => repoPath(root));
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.name.endsWith(extension)) {
        found.push(path.relative(ROOT, full).split(path.sep).join('/'));
      }
    }
  }
  return found.sort();
}

const read = (file) => fs.readFileSync(repoPath(file), 'utf8');
// A comment may mention a <pre>. The scan is about what is drawn.
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const filesMatching = (pattern) => sourceFiles('.tsx').filter((file) => !SHARED_COMPONENTS.has(file) && pattern.test(withoutComments(read(file))));

const MONOSPACE = /font(?:-family)?\s*:[^;]*(?:mono|menlo)/i;
const PRESERVED_SPACE = /white-space\s*:\s*pre/;
const CODE_ELEMENT = /(?:^|[\s>+~])(?:pre|textarea)(?:[:[.][^\s,]*)?$/;

// Every selector, from every stylesheet, that sets a code block's look.
function codeStyledSelectors() {
  const found = [];
  for (const file of sourceFiles('.css')) {
    for (const [, selectors, body] of withoutComments(read(file)).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (MONOSPACE.test(body)) {
        for (const selector of selectors.split(',').map((part) => part.trim())) {
          if (CODE_ELEMENT.test(selector) || PRESERVED_SPACE.test(body)) {
            found.push(selector);
          }
        }
      }
    }
  }
  return found;
}

test('a plain <pre> appears only in a shared component or on the list', () => {
  assert.deepEqual(filesMatching(/<pre\b/), Object.keys(PRE_ALLOWED).sort());
});

test('a plain <code> appears only in a shared component or on the list', () => {
  assert.deepEqual(filesMatching(/<code\b/), Object.keys(CODE_LABELS_ALLOWED).sort());
});

test('no component sets a monospace font on an element itself', () => {
  assert.deepEqual(filesMatching(/fontFamily:[^,}]*(?:mono|menlo)/i), []);
});

test('no stylesheet makes a code block of a plain element, past the list', () => {
  assert.deepEqual([...new Set(codeStyledSelectors())].sort(), Object.keys(STYLE_ALLOWED).sort());
});

test('the shared components exist, and the scan sees what it should', () => {
  assert.match(read('src/ui/CodeBlock.tsx'), /<pre\b/);
  assert.match(read('src/ui/CodeEditor.tsx'), /fontFamily: 'var\(--mono\)'/);
  assert.equal(CODE_ELEMENT.test('.page-template-files pre'), true);
  assert.equal(CODE_ELEMENT.test('.a textarea:focus'), true);
  assert.equal(CODE_ELEMENT.test('.prefix'), false);
  assert.equal(CODE_ELEMENT.test('.a > .pre'), false);
  assert.equal(MONOSPACE.test('font: 12px/1.6 ui-monospace, monospace;'), true);
  assert.equal(MONOSPACE.test('font-family: var(--mono);'), true);
  assert.equal(MONOSPACE.test('font-size: 12px;'), false);
});
