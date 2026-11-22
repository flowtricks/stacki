// Goal: pin that Settings -> Audits shows placeholder phrases (and the other lists) as filled tags, not as
// the Roles tab's full-width people rows, and that the card's All switch shares the row switches' column.
// Method: read the sources and stylesheet and assert the structure the design depends on: the chip class is
// the audit's own, it has a background fill, the remove button appears on hover or focus, and the heading's
// zero padding is specific enough to beat roles.css's 8px (which loads later).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath } = require('../../helpers/sources.js');

const component = fs.readFileSync(repoPath('src/app/settings/AuditsSettings.tsx'), 'utf8');
const css = fs.readFileSync(repoPath('src/features/audits/audits.css'), 'utf8');

test('a phrase is a tag of its own class, never the Roles people row', () => {
  assert.match(component, /className="audits-chip-item"/);
  assert.doesNotMatch(component, /app-role-chip/);
});

test('a tag has a background fill and a remove button that shows on hover and focus', () => {
  assert.match(css, /\.audits-chip-item \{[^}]*background: var\(--bg-active\)/);
  assert.match(css, /\.audits-chip-remove \{[^}]*opacity: 0/);
  assert.match(css, /\.audits-chip-item:hover \.audits-chip-remove,\s*\.audits-chip-remove:focus-visible \{[^}]*opacity: 1/);
});

test('the section heading pads nothing, with a selector that outranks roles.css', () => {
  assert.match(css, /\.audits-settings \.audits-settings-heading \{[^}]*padding: 0/);
});

test('the phrase panel draws no border line', () => {
  const panel = css.match(/\.audits-settings-subpanel \{[^}]*\}/);
  assert.ok(panel);
  assert.doesNotMatch(panel[0], /border/);
});
