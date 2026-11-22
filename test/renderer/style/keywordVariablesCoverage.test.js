// Goal: no input in the style panel is left without the variable connection, and no
// new one can be added without a decision about it. Every value control either takes
// a variable (the purple dot, the picker, the chip) or is listed here with the reason
// it cannot (a search box, a selector, one facet of a compound value).
//
//   node test/renderer/style/keywordVariablesCoverage.test.js
//
// Method: a mechanical scan of every .tsx file under src/features/style. Each file's
// input primitives are counted (`<input`, `<textarea`, `<Select`, `<SegmentedControl`,
// `role="radio"` segments). The registry below states those counts and what each
// control edits, so:
//   - a file with primitives that is not registered fails (a new input component);
//   - a count that moved fails (a new input in a registered file: audit it);
//   - a registered file that takes variables must use a variable-aware component;
//   - docs/style-panel-variables.md must name every registered file.
// The behaviour of the converted controls is checked in keywordVariables.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources.js');

const STYLE_DIRECTORY = repoPath('src/features/style');
const AUDIT_PATH = repoPath('docs/style-panel-variables.md');
const FILES_MAX = 2000;

const PRIMITIVES = {
  input: /<input\b/g,
  textarea: /<textarea\b/g,
  select: /<Select\b/g,
  segmented: /<SegmentedControl\b/g,
  radio: /role="radio"/g,
};
// The components that give a control the variable connection.
const VARIABLE_AWARE = /\b(VariableConnect|KeywordConnect|VariableSelect|KeywordSegments|KeywordVariableField|LiveInput|LiveTextInput|RatioOtherInput)\b/;

// Support: 'variable' took variables before this audit, 'converted' takes them since,
// 'exempt' cannot (the reason says why). Paths are relative to src/features/style.
const REGISTRY = {
  'AlignControl.tsx': { counts: { input: 1 }, controls: [['justify-content, align-items (Align X / Y dropdowns and their custom field)', 'converted']] },
  'AspectRatioField.tsx': {
    counts: { input: 3 },
    controls: [
      ['aspect-ratio (preset dropdown)', 'converted'],
      ['aspect-ratio (Other free field)', 'variable'],
      ['aspect-ratio W / H numbers', 'exempt', 'two halves of one ratio; a variable goes in the Other field'],
    ],
  },
  'BackgroundKit.tsx': { counts: { input: 1 }, controls: [['background-color and background fields', 'variable']] },
  'BackgroundLayerEditor.tsx': {
    counts: { segmented: 3 },
    controls: [['layer type, tile, fixed', 'exempt', 'one entry of a comma-separated layer list, and the type is a mode of the editor']],
  },
  'BackgroundLayerFields.tsx': {
    counts: { input: 3, segmented: 1 },
    controls: [
      ['background-size / background-position parts', 'converted'],
      ['overlay colour', 'converted'],
      ['image url', 'variable'],
      ['size mode (Custom / Cover / Contain)', 'exempt', 'a mode of the editor; the Width / Height parts take variables'],
    ],
  },
  'BordersSection.tsx': {
    counts: { input: 1, radio: 1 },
    controls: [
      ['border-style bar', 'converted'],
      ['border-width, border-color', 'variable'],
    ],
  },
  'BoxShadowsRow.tsx': { counts: { segmented: 1 }, controls: [['shadow inset / outset', 'exempt', 'a keyword inside one shadow of a list']] },
  'codeChips/CodeChips.tsx': {
    counts: { segmented: 1 },
    controls: [['a code chip’s gradient type', 'exempt', 'it edits code, where a variable is its own chip (the variable picker)']],
  },
  'CustomValueEditor.tsx': { counts: { textarea: 1 }, controls: [['the large value editor, any property', 'variable']] },
  'DecorationPopover.tsx': {
    counts: { select: 1 },
    controls: [
      ['text-decoration-skip-ink', 'converted'],
      ['text-decoration line / style facets', 'exempt', 'facets of the text-decoration shorthand, written together'],
      ['text-decoration-thickness, color', 'variable'],
    ],
  },
  'DirectionControl.tsx': { counts: { input: 1, radio: 1 }, controls: [['flex-direction bar', 'converted']] },
  'DisplayControl.tsx': { counts: { input: 1, radio: 2 }, controls: [['display bar', 'converted']] },
  'EasingEditor.tsx': { counts: { input: 1 }, controls: [['transition-timing-function', 'variable']] },
  'EffectsKit.tsx': {
    counts: { input: 2 },
    controls: [
      ['mix-blend-mode, cursor (preset dropdowns)', 'converted'],
      ['effect free fields', 'variable'],
    ],
  },
  'FilterFields.tsx': { counts: { select: 1 }, controls: [['filter function type', 'exempt', 'the name of a function inside a filter list, not a value']] },
  'FlexChildSection.tsx': {
    counts: { radio: 1 },
    controls: [
      ['flex sizing bar', 'converted'],
      ['flex-grow, flex-shrink, flex-basis, grid lines', 'variable'],
    ],
  },
  'GapControl.tsx': { counts: { input: 1 }, controls: [['gap, row-gap, column-gap', 'variable']] },
  'GradientCode.tsx': { counts: { textarea: 1 }, controls: [['gradient code', 'variable']] },
  'GradientEditor.tsx': {
    counts: { input: 2 },
    controls: [
      ['gradient stop colour', 'converted'],
      ['repeating checkbox', 'exempt', 'a switch between two functions, not a value'],
    ],
  },
  'GridAreas.tsx': {
    counts: { input: 2 },
    controls: [['grid area names and cell numbers', 'exempt', 'identifiers and cell indexes; var() is not valid there']],
  },
  'GridAxisMode.tsx': {
    counts: { segmented: 1 },
    controls: [['track mode (count / expression)', 'exempt', 'a mode of the editor; the expression takes variables']],
  },
  'GridControls.tsx': { counts: { input: 1 }, controls: [['justify-items, align-items (grid align X / Y)', 'converted']] },
  'GridFlowControls.tsx': {
    counts: { input: 2, segmented: 2 },
    controls: [
      ['grid-auto-flow bar', 'converted'],
      ['justify-content, align-content bars', 'converted'],
      ['track count', 'exempt', 'a count of equal tracks; any other value is the expression field'],
    ],
  },
  'GridTrackExpression.tsx': { counts: { input: 1 }, controls: [['grid-template-columns / rows', 'variable']] },
  'KeywordConnect.tsx': { counts: { input: 2, select: 1 }, controls: [['the connection itself (VariableSelect, KeywordSegments)', 'variable']] },
  'LiveTextInput.tsx': { counts: { input: 1 }, controls: [['typography text fields', 'variable']] },
  'ObjectFitFields.tsx': {
    counts: { input: 2 },
    controls: [
      ['object-fit dropdown', 'converted'],
      ['object-fit free field, object-position', 'variable'],
    ],
  },
  'OpacityRow.tsx': { counts: { input: 1 }, controls: [['opacity', 'variable']] },
  'PositionSection.tsx': {
    counts: { input: 2, radio: 1 },
    controls: [
      ['position dropdown', 'converted'],
      ['top / right / bottom / left, z-index', 'variable'],
      ['inset presets', 'exempt', 'shortcuts that write four lengths at once'],
    ],
  },
  'PositionSegments.tsx': { counts: { input: 1, radio: 1 }, controls: [['float, clear bars', 'converted']] },
  'SegmentedField.tsx': { counts: { input: 1, radio: 1 }, controls: [['pointer-events, outline-style bars', 'converted']] },
  'ShadowFields.tsx': { counts: { input: 1 }, controls: [['shadow lengths and colour', 'variable']] },
  'SizeKit.tsx': { counts: { input: 1 }, controls: [['width, height, min / max', 'variable']] },
  'SizeSegmentBar.tsx': { counts: { input: 1, radio: 1 }, controls: [['overflow, box-sizing bars', 'converted']] },
  'SpacingEditor.tsx': { counts: { input: 4 }, controls: [['margin, padding', 'variable']] },
  'TextWrapRows.tsx': {
    counts: { segmented: 1 },
    controls: [
      ['white-space, word-break, overflow-wrap dropdowns', 'converted'],
      ['text-overflow bar', 'converted'],
    ],
  },
  'TokenField.tsx': { counts: { input: 2 }, controls: [['the chip editor itself', 'variable']] },
  'TrackEditor.tsx': {
    counts: { input: 2, segmented: 1 },
    controls: [
      ['track sizes', 'variable'],
      ['track sizing mode, auto-fit checkbox', 'exempt', 'modes of the track editor'],
    ],
  },
  'TransformSettings.tsx': {
    counts: { input: 1, segmented: 1 },
    controls: [
      ['backface-visibility bar', 'converted'],
      ['transform-origin, perspective', 'variable'],
    ],
  },
  'TransformsRow.tsx': {
    counts: { input: 1, segmented: 1 },
    controls: [
      ['transform values', 'variable'],
      ['transform type', 'exempt', 'the name of a function inside a transform list'],
    ],
  },
  'TransitionsRow.tsx': {
    counts: { select: 1 },
    controls: [
      ['transition property', 'exempt', 'one entry of a transition list, a property name'],
      ['transition duration, timing', 'variable'],
    ],
  },
  'TypographyColumns.tsx': {
    counts: { segmented: 1 },
    controls: [
      ['column-span bar', 'converted'],
      ['column-rule-style bar', 'converted'],
      ['columns, column-gap, rule width / colour', 'variable'],
    ],
  },
  'TypographyKit.tsx': {
    counts: { radio: 1 },
    controls: [['text-align, text-decoration, text-transform, font-style, direction, align-self, justify-self, order bars', 'converted']],
  },
  'VariableConnect.tsx': { counts: { input: 3, textarea: 1 }, controls: [['the connect wrapper itself', 'variable']] },
  'VariablePicker.tsx': { counts: { input: 1 }, controls: [['picker search', 'exempt', 'searches the list; not a value']] },
  'clipPath/ClipPathView.tsx': {
    counts: { input: 1, segmented: 1 },
    controls: [
      ['clip-path variable field', 'variable'],
      ['shape fit mode', 'exempt', 'a mode of the shape editor'],
    ],
  },
  'components/ColorPicker.tsx': {
    counts: { input: 1 },
    controls: [['hex text inside the colour picker', 'exempt', 'the picker of a field that takes variables']],
  },
  'components/LiveInput.tsx': { counts: { input: 1 }, controls: [['the shared value field', 'variable']] },
  'components/SelectViews.tsx': { counts: { input: 1 }, controls: [['dropdown search', 'exempt', 'searches the list; not a value']] },
  'embed/AddProperty.tsx': { counts: { input: 2, textarea: 1 }, controls: [['Other properties rows', 'variable']] },
  'embed/QueryForms.tsx': {
    counts: { input: 2, segmented: 2 },
    controls: [['media / container query forms', 'exempt', 'query conditions, not property values']],
  },
  'embed/ResolvedRows.tsx': { counts: {}, controls: [['vertical-align dropdown', 'converted']] },
  'embed/SelectorPicker.tsx': { counts: { input: 3 }, controls: [['selector picker', 'exempt', 'selectors, not property values']] },
  'embed/StyleCard.tsx': { counts: { select: 2 }, controls: [['state and breakpoint menus', 'exempt', 'which rule is edited, not a value']] },
};

function listSources(directory) {
  const found = [];
  const pending = [directory];
  while (pending.length > 0) {
    assert.ok(found.length < FILES_MAX, 'the style folder stays under the file limit');
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.name.endsWith('.tsx')) {
        found.push(full);
      }
    }
  }
  return found;
}

function countsOf(source) {
  const counts = {};
  for (const [name, pattern] of Object.entries(PRIMITIVES)) {
    const matches = source.match(pattern)?.length ?? 0;
    if (matches > 0) {
      counts[name] = matches;
    }
  }
  return counts;
}

// The registry key of a file: its path under the style folder, written with `/` on every platform.
const keyOf = (file) => path.relative(STYLE_DIRECTORY, file).split(path.sep).join('/');

const failures = [];
const audit = fs.readFileSync(AUDIT_PATH, 'utf8');
const seen = new Set();
for (const file of listSources(STYLE_DIRECTORY)) {
  const key = keyOf(file);
  const source = fs.readFileSync(file, 'utf8');
  const counts = countsOf(source);
  const entry = REGISTRY[key];
  if (entry === undefined) {
    if (Object.keys(counts).length > 0) {
      failures.push(`${key} has input controls ${JSON.stringify(counts)} but is not in the registry: audit it (variable support or a reason)`);
    }
    continue;
  }
  seen.add(key);
  if (JSON.stringify(counts) !== JSON.stringify(entry.counts)) {
    failures.push(`${key}: input controls moved from ${JSON.stringify(entry.counts)} to ${JSON.stringify(counts)}: audit the new one`);
  }
  const takesVariables = entry.controls.some(([, support]) => support !== 'exempt');
  if (takesVariables && !VARIABLE_AWARE.test(source)) {
    failures.push(`${key} is registered as taking variables but uses no variable-aware component`);
  }
  for (const [what, support, reason] of entry.controls) {
    if (support === 'exempt' && (reason === undefined || reason.length === 0)) {
      failures.push(`${key}: ${what} is exempt without a reason`);
    }
    if (!['variable', 'converted', 'exempt'].includes(support)) {
      failures.push(`${key}: ${what} has unknown support ${support}`);
    }
  }
  if (!audit.includes(`\`${key}\``)) {
    failures.push(`docs/style-panel-variables.md does not list ${key}`);
  }
}
for (const key of Object.keys(REGISTRY)) {
  if (!seen.has(key)) {
    failures.push(`${key} is registered but no longer exists`);
  }
}
// A keyword dropdown in a file that takes variables is a VariableSelect: a bare Select there
// is either an exempt control (counted above) or the connection itself.
const bareSelectFiles = Object.entries(REGISTRY).filter(([key, entry]) => (entry.counts.select ?? 0) > 0 && key !== 'KeywordConnect.tsx');
for (const [key, entry] of bareSelectFiles) {
  const exemptCount = entry.controls.filter(([, support]) => support === 'exempt').length;
  if (exemptCount === 0) {
    failures.push(`${key} renders a bare <Select> but lists no exempt control for it: use VariableSelect`);
  }
}

const controls = Object.values(REGISTRY).flatMap((entry) => entry.controls);
const tally = (support) => controls.filter(([, each]) => each === support).length;
if (failures.length > 0) {
  console.error(`keyword-variables-coverage: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `keyword-variables-coverage: ${seen.size} files, ${controls.length} controls (${tally('variable')} already, ${tally('converted')} converted, ${tally('exempt')} exempt)`,
);
