// Goal: the app UI kit (shared/properties/appUiKit.ts) is the editor's own
// components and cannot drift from them. The generated module is exactly what
// scripts/build/appUiKit.mts builds from the editor today (its components
// compiled, the CSS they import collected); the kit's component CSS holds every
// rule of every shared sheet the components use, unchanged, inside one `@scope`
// (compared rule by rule with PostCSS, an independent parser); every exported
// token's value is the editor's own, read from the variable or rule it names.
// The host's answers for the reserved `__stacki/` folder are pinned: the three
// kit files with their types, a 404 for any other reserved path, and the
// bundle's own files left alone. Tokens are injected into HTML documents only,
// where a `<meta charset>` stays first. A bundle that ships `__stacki/` is
// refused, naming the file.
// Method: import the builder, load the generated module and the shared modules
// through the renderer bundler, read the editor's sheets from disk, and compare; build
// bundles in memory from the example app's files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const { pathToFileURL } = require('node:url');
const load = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources');

const generated = load('shared/properties/generated/appUiKitBundle.ts');
const kit = load('shared/properties/appUiKit.ts');
const bundles = load('shared/properties/appBundle.ts');

const read = (file) => fs.readFileSync(repoPath(file), 'utf8');
// The builder runs under Node itself (it drives esbuild, which cannot be bundled into a test module).
let builder;
let sources;
test.before(async () => {
  builder = await import(pathToFileURL(repoPath('scripts/build/appUiKitSource.mts')).href);
  sources = Object.fromEntries(Object.entries(builder.KIT_SOURCE_FILES).map(([name, file]) => [name, read(file)]));
});

test('the generated module is what the editor CSS builds today', () => {
  const expected = builder.appUiKitModule(builder.buildAppUiKit(sources, builder.bundleAppUiKit(repoPath('.'))));
  assert.equal(read('shared/properties/generated/appUiKitBundle.ts'), expected, 'run node scripts/build/appUiKit.mts');
});

// The editor's custom properties and rules, as PostCSS reads them.
function editorRoot(file) {
  return postcss.parse(read(file));
}
function rootVariables() {
  const variables = new Map();
  for (const file of [builder.KIT_SOURCE_FILES.styleTokens, builder.KIT_SOURCE_FILES.editor]) {
    editorRoot(file).walkRules(':root', (rule) => {
      if (rule.parent.type !== 'root') {
        return;
      }
      rule.walkDecls(/^--/, (declaration) => variables.set(declaration.prop, declaration.value.replace(/\s+/g, ' ').trim()));
    });
  }
  return variables;
}
function resolve(value, variables) {
  let resolved = value;
  for (let step = 0; step < 8 && resolved.includes('var('); step += 1) {
    resolved = resolved.replace(/var\((--[\w-]+)(?:,[^()]*(?:\([^()]*\))?[^()]*)?\)/g, (_whole, name) => variables.get(name));
  }
  return resolved;
}

test('every exported token exists in the editor CSS, with the editor value', () => {
  const variables = rootVariables();
  const values = generated.APP_UI_TOKEN_VALUES.dark;
  assert.deepEqual(
    [...generated.APP_UI_TOKEN_NAMES],
    builder.TOKEN_SOURCES.map((token) => token.name),
  );
  assert.ok(generated.APP_UI_TOKEN_NAMES.length >= 30, 'colours, radii, spacing, type, shadow and focus');
  for (const { name, source } of builder.TOKEN_SOURCES) {
    let editorValue;
    if (source.kind === 'variable') {
      editorValue = variables.get(source.variable);
      assert.ok(editorValue !== undefined, `${source.variable} is declared on the editor's :root (${name})`);
    } else {
      let found;
      editorRoot(builder.KIT_SOURCE_FILES[source.file]).walkRules((rule) => {
        if (rule.parent.type === 'root' && rule.selector.replace(/\s+/g, ' ') === source.selector) {
          rule.walkDecls(source.property, (declaration) => {
            found = declaration.value.replace(/\s+/g, ' ').trim();
          });
        }
      });
      assert.ok(found !== undefined, `${source.selector} { ${source.property} } is in ${builder.KIT_SOURCE_FILES[source.file]} (${name})`);
      editorValue = source.part === undefined ? found : found.split(' ')[source.part];
    }
    assert.equal(values[name], resolve(editorValue, variables), `--stacki-${name}`);
    assert.ok(generated.APP_UI_TOKENS_CSS.includes(`--stacki-${name}: ${values[name]};`), `the token sheet declares --stacki-${name}`);
  }
});

// Each rule of a sheet, as `selector { declarations }` with whitespace normalised.
function rules(css) {
  const found = [];
  postcss.parse(css).walkRules((rule) => {
    if (rule.parent.type === 'atrule' && rule.parent.name === 'scope') {
      // The kit's own scope wrapper: its rules are compared as if at the top.
    } else if (rule.parent.type !== 'root' && rule.parent.type !== 'atrule') {
      return;
    }
    const body = [];
    rule.walkDecls((declaration) => body.push(`${declaration.prop}: ${declaration.value.replace(/\s+/g, ' ')}${declaration.important ? ' !important' : ''}`));
    const media = rule.parent.type === 'atrule' && rule.parent.name !== 'scope' ? `@${rule.parent.name} ${rule.parent.params} ` : '';
    // The bundler drops the quotes around an attribute value that needs none (`[aria-checked=true]`): spelling, not a change.
    const selectors = rule.selectors.map((selector) => selector.replace(/\s+/g, ' ').replace(/=(['"])([\w-]+)\1\]/g, '=$2]'));
    found.push(`${media}${selectors.join(', ')} { ${body.join('; ')} }`);
  });
  return found;
}

const SHARED_SHEETS = [
  'src/ui/controls.css',
  'src/ui/dropdown.css',
  'src/ui/resetLabel.css',
  'src/ui/popup.css',
  'src/ui/switch.css',
  'src/ui/segmentedTabs.css',
  'src/ui/searchField.css',
];

test("the kit's component CSS is the editor's shared sheets, rule for rule, inside one scope", () => {
  const css = generated.APP_UI_COMPONENTS_CSS;
  assert.match(css, /^@scope \(\.stacki-ui\) \{/);
  const kitRules = new Set(rules(css));
  for (const sheet of SHARED_SHEETS) {
    const sheetRules = rules(read(sheet));
    assert.ok(sheetRules.length > 0, sheet);
    for (const rule of sheetRules) {
      assert.ok(kitRules.has(rule), `${sheet}: ${rule.slice(0, 160)}`);
    }
  }
  for (const component of [
    'src/ui/Dropdown.tsx',
    'src/ui/Switch.tsx',
    'src/ui/SegmentedTabs.tsx',
    'src/ui/SearchField.tsx',
    'src/ui/ResetLabel.tsx',
    'src/ui/Tooltip.tsx',
  ]) {
    assert.ok(
      read('src/features/apps/uiKit/kitElements.tsx').includes(component.replace('src/ui/', '../../../ui/').replace('.tsx', '')),
      `the kit compiles ${component}`,
    );
  }
  // The editor imports the same sheets: its main stylesheet, or the component itself.
  const editor = read('src/app/styles.css');
  for (const sheet of ['controls', 'dropdown', 'resetLabel']) {
    assert.ok(editor.includes(`@import '../ui/${sheet}.css';`), `styles.css imports ${sheet}.css`);
  }
  assert.ok(!/(^|\n)\.dd-trigger \{/.test(editor), 'the dropdown rules live in their shared sheet only');
});

test('the reserved folder serves the three kit files, refuses other reserved paths and leaves the bundle alone', () => {
  const css = kit.appHostAsset('__stacki/ui.css');
  assert.equal(css.kind, 'kit');
  assert.equal(css.type, 'text/css; charset=utf-8');
  assert.ok(css.body.includes(':where(:root)'), 'ui.css carries the tokens');
  assert.ok(css.body.includes('.dd-trigger'), 'and the components');
  const tokens = kit.appHostAsset('__stacki/tokens.css');
  assert.equal(tokens.kind, 'kit');
  assert.ok(!tokens.body.includes('.dd-trigger'), 'tokens.css is variables only');
  const script = kit.appHostAsset('__stacki/ui.js');
  assert.equal(script.type, 'text/javascript; charset=utf-8');
  assert.doesNotThrow(() => new Function(script.body), 'ui.js parses');
  assert.deepEqual(kit.appHostAsset('__stacki/other.css'), { kind: 'reserved' });
  assert.deepEqual(kit.appHostAsset('__STACKI/ui.css'), { kind: 'reserved' }, 'the folder is reserved in any case');
  assert.deepEqual(kit.appHostAsset('__stacki/nested/ui.css'), { kind: 'reserved' });
  assert.deepEqual(kit.appHostAsset('index.html'), { kind: 'bundle' });
  assert.deepEqual(kit.appHostAsset('assets/__stacki/ui.css'), { kind: 'bundle' }, 'only the root folder is reserved');
  assert.throws(() => kit.appHostAsset('/__stacki/ui.css'), /relative to the app origin/);
});

test('the tokens are injected into HTML only, before the head closes', () => {
  const encode = (text) => new TextEncoder().encode(text);
  const decode = (bytes) => new TextDecoder().decode(bytes);
  const page = '<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body></body></html>';
  const injected = decode(kit.withAppTokens({ bytes: encode(page), type: 'text/html; charset=utf-8' }));
  assert.ok(injected.startsWith('<!doctype html><html><head><meta charset="utf-8"><title>x</title><style data-stacki-tokens>'), injected.slice(0, 120));
  assert.ok(injected.includes('--stacki-accent: #0099ff;'));
  assert.ok(!injected.includes('.stacki-button'), 'variables only');
  const bare = decode(kit.withAppTokens({ bytes: encode('<!DOCTYPE html><p>hi</p>'), type: 'text/html; charset=utf-8' }));
  assert.ok(bare.startsWith('<!DOCTYPE html><style data-stacki-tokens>'), 'after the doctype, so the page stays in standards mode');
  const bodyOnly = decode(kit.withAppTokens({ bytes: encode('<html><BODY>x</BODY></html>'), type: 'text/html' }));
  assert.ok(bodyOnly.startsWith('<html><style data-stacki-tokens>'), bodyOnly.slice(0, 40));
  const script = encode('console.log("</head>")');
  assert.equal(kit.withAppTokens({ bytes: script, type: 'text/javascript; charset=utf-8' }), script, 'other files are untouched');
});

test('the theme view has every token, and unknown themes read as the default', () => {
  const view = kit.appThemeView('dark');
  assert.equal(view.theme, 'dark');
  assert.deepEqual(Object.keys(view.tokens), [...generated.APP_UI_TOKEN_NAMES]);
  assert.equal(kit.parseAppUiTheme('dark'), 'dark');
  assert.equal(kit.parseAppUiTheme(undefined), 'dark');
  assert.equal(kit.parseAppUiTheme('neon'), 'dark');
});

test('a bundle that ships its own __stacki/ folder is refused, naming the file', () => {
  const fixture = repoPath('test/fixtures/apps/selection-outline');
  const files = fs.readdirSync(fixture).map((name) => ({ path: name, bytes: new Uint8Array(fs.readFileSync(path.join(fixture, name))) }));
  assert.equal(bundles.bundleFromFiles(files).manifest.id, 'selection-outline', 'the example app, which links the kit, is accepted');
  const extra = { path: '__stacki/ui.css', bytes: new TextEncoder().encode('body{}') };
  assert.throws(() => bundles.bundleFromFiles([...files, extra]), /__stacki\/ is served by Stacki \(its UI kit\); remove __stacki\/ui\.css from the bundle/);
  const anyCase = { path: '__Stacki/theme.css', bytes: new TextEncoder().encode('body{}') };
  assert.throws(() => bundles.bundleFromFiles([...files, anyCase]), /remove __Stacki\/theme\.css/);
  const nested = { path: 'styles/__stacki.css', bytes: new TextEncoder().encode('body{}') };
  assert.doesNotThrow(() => bundles.bundleFromFiles([...files, nested]), 'a file merely named like it elsewhere is fine');
});
