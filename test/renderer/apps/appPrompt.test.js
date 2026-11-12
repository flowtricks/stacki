// Goal: the "Build an app" prompt is short, generated from one source and cannot
// drift. The generated module is exactly docs/apps-prompt.md; the prompt covers
// what an agent needs to start (the manifest's id, name, version, icon and
// author.github, the SDK, packaging and testing) and links to the full guide;
// the full guide (docs/apps.md) names every RPC method and event in the shared
// tables; its reference listings cannot drift from the RPC table: the Methods
// table lists every method once and nothing else, the Events table and the
// `AppEventName` type every event once, and the SDK's `interface Stacki` a helper
// for every method in its namespace; and the manifest's window modes, size bounds and default popup size; neither names an external host the Studio bundle would have to review.
// Method: read both Markdown files and the generated module's text, load the
// prompt and the tables through the renderer bundler, and compare.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const load = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources');

const source = fs.readFileSync(repoPath('docs/apps-prompt.md'), 'utf8');
const guide = fs.readFileSync(repoPath('docs/apps.md'), 'utf8');
const { appBuildPrompt } = load('src/features/apps/appPrompt.ts');
const { APPS_PROMPT } = load('src/features/apps/generated/appsPrompt.ts');
const rpc = load('shared/properties/appsRpc.ts');
const apps = load('shared/properties/apps.ts');

const PROMPT_CHARS_MAX = 8_000;

test('the generated prompt is docs/apps-prompt.md, byte for byte, and is what is copied', () => {
  assert.equal(APPS_PROMPT, source, 'run node scripts/build/appsPrompt.mts');
  assert.equal(appBuildPrompt(), source);
});

test('the prompt is short and has what an agent needs to start', () => {
  assert.ok(source.length < PROMPT_CHARS_MAX, `${source.length} characters`);
  for (const needed of [
    'stacki-app.json',
    '"id"',
    '"name"',
    '"version"',
    '"icon"',
    '"author"',
    'stacki-sdk.js',
    'zip -r',
    'Load App From GitHub',
    'stacki.build/docs/apps',
    'docs/apps.md',
  ]) {
    assert.ok(source.includes(needed), needed);
  }
  assert.ok(!source.includes('capabilit'), 'apps ask for no permissions');
});

test('the full guide documents every method and event', () => {
  for (const method of rpc.APP_METHOD_NAMES) {
    assert.ok(guide.includes(`\`${method}\``), method);
  }
  for (const event of rpc.APP_EVENT_NAMES) {
    assert.ok(guide.includes(`\`${event}\``), event);
  }
  for (const field of ['author.github', 'manifestVersion', 'stacki-app.json', 'stacki-sdk.js', 'apps.json', 'icon']) {
    assert.ok(guide.includes(field), field);
  }
});

test('the full guide documents the window field as the parser bounds it', () => {
  for (const mode of apps.APP_WINDOW_MODES) {
    assert.ok(guide.includes(`"${mode}"`), mode);
  }
  const { windowWidthPxMin, windowWidthPxMax, windowHeightPxMin, windowHeightPxMax } = apps.APP_LIMITS;
  assert.ok(guide.includes(`"width": ${windowWidthPxMin}–${windowWidthPxMax}`), 'width bounds');
  assert.ok(guide.includes(`"height": ${windowHeightPxMin}–${windowHeightPxMax}`), 'height bounds');
  assert.ok(guide.includes(`${apps.APP_WINDOW_DEFAULT.widthPx} × ${apps.APP_WINDOW_DEFAULT.heightPx}`), 'default popup size');
  assert.ok(guide.includes('## Window: docked or popup'), 'the docked and popup section');
  assert.ok(source.includes('"mode": "popup"'), 'the prompt names the popup mode');
});

test('neither names a literal external host', () => {
  // The prompt ships in Studio's browser bundle, whose literal hosts are a reviewed allowlist (studio/scripts/noTracking.ts).
  for (const text of [source, guide]) {
    assert.deepEqual(text.match(/\bhttps?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) ?? [], []);
  }
});

// The guide's reference listings, read as a reader sees them: each section between its heading and the next.
function guideSection(heading) {
  const start = guide.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, heading);
  const rest = guide.slice(start + heading.length + 2);
  const next = rest.search(/\n#{2,3} /);
  return next < 0 ? rest : rest.slice(0, next);
}
function tableNames(section) {
  return section
    .split('\n')
    .map((line) => /^\| `([a-z]+\.[A-Za-z]+)` \|/.exec(line)?.[1])
    .filter((name) => name !== undefined);
}
function duplicates(names) {
  return names.filter((name, index) => names.indexOf(name) !== index);
}

test('the Methods table lists every RPC method exactly once, and nothing else', () => {
  const listed = tableNames(guideSection('### Methods'));
  assert.deepEqual(duplicates(listed), [], 'listed twice');
  assert.deepEqual([...listed].sort(), [...rpc.APP_METHOD_NAMES].sort());
});

test('the Events table and the AppEventName type list every event exactly once', () => {
  const listed = tableNames(guideSection('### Events'));
  assert.deepEqual(duplicates(listed), [], 'listed twice');
  assert.deepEqual([...listed].sort(), [...rpc.APP_EVENT_NAMES].sort());
  const union = /type AppEventName =([\s\S]*?);/.exec(guideSection('### Types'));
  assert.ok(union, 'the Types block declares AppEventName');
  const typed = [...union[1].matchAll(/'([a-z]+\.[A-Za-z]+)'/g)].map((match) => match[1]);
  assert.deepEqual(duplicates(typed), [], 'typed twice');
  assert.deepEqual([...typed].sort(), [...rpc.APP_EVENT_NAMES].sort());
});

test("the SDK's interface has a helper for every method, in its namespace", () => {
  const sdk = guideSection('## The SDK');
  const at = sdk.indexOf('interface Stacki {');
  assert.ok(at >= 0, 'the interface is listed');
  // The interface's body, braces matched; bounded by the section's length.
  let depth = 0;
  let end = at;
  for (let index = sdk.indexOf('{', at); index < sdk.length; index += 1) {
    depth += sdk[index] === '{' ? 1 : sdk[index] === '}' ? -1 : 0;
    if (depth === 0) {
      end = index;
      break;
    }
  }
  const body = sdk.slice(at, end);
  const missing = [];
  for (const method of rpc.APP_METHOD_NAMES) {
    const [namespace, name] = method.split('.');
    const open = body.indexOf(`readonly ${namespace}: {`);
    if (open < 0) {
      missing.push(method);
      continue;
    }
    // The namespace's own block: up to the next `readonly <namespace>:` at the interface's top level.
    const next = body.slice(open + 1).search(/\n  readonly [a-z]+: /);
    const block = next < 0 ? body.slice(open) : body.slice(open, open + 1 + next);
    if (!new RegExp(`\\b${name}[<(]`).test(block)) {
      missing.push(method);
    }
  }
  assert.deepEqual(missing, []);
});
