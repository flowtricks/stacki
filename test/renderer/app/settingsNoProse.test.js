// Goal: Settings cards hold a title and, at most, one short line; every longer explanation sits behind the
// shared (i) hint, which is reachable by keyboard and screen reader and is drawn above popups.
// Method: read the sources and the English catalog (the other locales are held to the same keys by the
// catalog parity test): the hint is a labelled, described button that shows at once on focus and is drawn on
// the body above popups; the Editor settings catalog has no description or intro keys; each tip stays within
// 30 words; and the screens' sources no longer render the removed intro sentences.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath } = require('../../helpers/sources.js');

const read = (file) => fs.readFileSync(repoPath(file), 'utf8');

test('the info hint is a labelled, described button, shown at once on focus, drawn above popups', () => {
  const source = read('src/ui/InfoHint.tsx');
  assert.match(source, /<button[^>]*type="button"/);
  assert.match(source, /aria-label=\{translate\('settings\.info\.label'\)\}/, 'the name is the translated "More information"');
  assert.match(source, /aria-describedby=\{descriptionId\}/, 'the tip text is the button description');
  assert.match(source, /onFocus=\{[^}]*showNow/, 'keyboard focus shows the tip without the hover wait');
  assert.match(source, /createPortal\(/, 'the tip is drawn on the body so the dialog never clips it');
  assert.match(read('src/ui/infoHint.css'), /\.rail-tooltip\.settings-info-tip\s*\{[^}]*z-index:\s*10001/, 'above popups');
  for (const tab of ['McpTab.tsx', 'McpAddSection.tsx', 'SecretsTab.tsx']) {
    assert.match(read(`src/features/projectSettings/${tab}`), /import InfoHint from '\.\.\/\.\.\/ui\/InfoHint'/, `${tab} uses the shared hint from ui/`);
  }
});

test('Editor settings keep no description or intro keys, and every tip is at most 30 words', () => {
  const catalog = read('shared/properties/i18n/messages/en/settings.ts');
  for (const gone of ['settings.editor.intro', 'settings.editor.sound.description', 'settings.language.description', 'askBeforeTrust.description']) {
    assert.ok(!catalog.includes(`'${gone}`), `${gone} is removed`);
  }
  assert.doesNotMatch(catalog, /not translated yet/i, 'the Language tip does not mention untranslated parts');
  const tips = [...catalog.matchAll(/'(settings\.[\w.]*\.info)':\s*'([^']*)'/g)];
  assert.ok(tips.length >= 10, 'the tips are found');
  for (const [, key, text] of tips) {
    assert.ok(text.split(/\s+/).length <= 30, `${key} is at most 30 words`);
  }
});

test('no settings screen renders its removed intro sentences', () => {
  const sources = ['Settings.tsx', 'FolderSettings.tsx', 'RolesSettings.tsx', 'AuditsSettings.tsx', 'InstructionsSettings.tsx'].map((name) =>
    read(`src/app/settings/${name}`),
  );
  sources.push(read('src/features/studioSetup/StudioSetup.tsx'));
  const text = sources.join('\n');
  for (const gone of [
    'Changes save as you make them',
    'Already installed',
    'Choose what each role can use',
    'Shared with the team in',
    'Files and folders the Instructions panel',
  ]) {
    assert.ok(!text.includes(gone), `"${gone}" is gone`);
  }
});
