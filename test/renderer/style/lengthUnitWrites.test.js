// Goal: in a rem project (Lumos) every length the style panel writes is rem, and
// in a px project nothing changes. The setting is the host's `lengthUnit`; the
// controls read it through src/features/style/model/lengthUnit.ts.
//
// Methodology: bundle the panel's unit layer with the models and controls that
// write lengths, then drive each write path as the control does — the filter
// editor's amount slider and default, a box shadow's slider and serialisation,
// an outline typed as px, a spacing side dragged from a px value, and arrow and
// scrub steps — once under a px host and once under a rem host. Each value is
// checked as it reaches setProp (`writtenValue`, the funnel every write passes).

const fs = require('node:fs');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, actual, expected) => {
  checked += 1;
  if (actual !== expected) {
    failures.push(`  ${what}\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'length-unit-writes.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        export { writtenValue, sliderLength, projectLengthUnit } from './model/lengthUnit';
        export { getHost, setHost } from './model/host';
        export { findScrubTarget, scrubNumber, stepNumberAtCaret } from './model/numberStep';
        export { blankFilter, parseFilters, serializeFilters, FILTER_META } from './model/filter';
        export { blankBoxShadow, parseBoxShadows, serializeBoxShadows } from './model/boxShadow';
        export { formatLength, startSideDrag, dragValue } from './SpacingFill';
        export { projectAxisConfig, projectAxis, parseAxis } from './TransformsRow';
      `,
      resolveDir: repoPath('src/features/style'),
      loader: 'tsx',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    loader: { '.css': 'empty', '.svg': 'text' },
  });
  const style = require(bundlePath);
  const PX = { kind: 'px' };
  const REM = { kind: 'rem', rootFontPx: 16 };
  const useHost = (lengthUnit) => style.setHost({ ...style.getHost(), lengthUnit });

  // The host starts in px, so a project with no scan yet keeps today's behaviour.
  check('host default is px', style.projectLengthUnit().kind, 'px');

  // Filter: the Amount slider (FilterFields → ShadowLength) and the type default.
  const blur = style.FILTER_META.blur;
  const pxBlur = style.sliderLength({ amount: 12, unit: 'px' }, blur.unit, blur, PX);
  check('px project: blur slider writes px', pxBlur.format(13), '13px');
  const remBlur = style.sliderLength({ amount: 12, unit: 'px' }, blur.unit, blur, REM);
  check('rem project: a 12px blur sits at 12 on the pixel slider', remBlur.position, 12);
  check('rem project: blur slider writes rem', remBlur.format(13), '0.8125rem');
  check('rem project: blur slider steps one pixel', remBlur.step, 1);
  check('rem project: a bare blur takes rem', remBlur.unit, 'rem');
  check('rem project: an empty blur defaults to rem', style.sliderLength(undefined, 'px', blur, REM).unit, 'rem');
  const remValue = style.sliderLength({ amount: 0.75, unit: 'rem' }, blur.unit, blur, REM);
  check('rem project: a 0.75rem blur sits at 12px', remValue.position, 12);
  const brightness = style.FILTER_META.brightness;
  check('rem project: a % filter keeps %', style.sliderLength({ amount: 120, unit: '%' }, brightness.unit, brightness, REM).format(150), '150%');
  const defaultFilter = style.serializeFilters([style.blankFilter('blur')]);
  check('px project: a new blur writes 4px', style.writtenValue('backdrop-filter', defaultFilter, PX), 'blur(4px)');
  check('rem project: a new blur writes rem', style.writtenValue('backdrop-filter', defaultFilter, REM), 'blur(0.25rem)');
  const drop = style.serializeFilters([style.blankFilter('drop-shadow')]);
  check('rem project: a new drop shadow writes rem', style.writtenValue('filter', drop, REM), 'drop-shadow(0rem 0.125rem 0.3125rem rgba(0, 0, 0, 0.7))');
  const reread = style.parseFilters('blur(0.75rem)');
  check('a rem blur reads back as rem', reread[0] && reread[0].amount, '0.75rem');

  // Box shadow: a slider move on one layer, then the whole list as written.
  const shadows = style.parseBoxShadows('0px 4px 8px 0px rgba(0, 0, 0, 0.2)');
  const shadowSlider = style.sliderLength({ amount: 8, unit: 'px' }, 'px', { min: 0, max: 50 }, REM);
  const moved = shadows.map((shadow) => ({ ...shadow, blur: shadowSlider.format(10) }));
  check(
    'rem project: box shadow writes rem',
    style.writtenValue('box-shadow', style.serializeBoxShadows(moved), REM),
    '0rem 0.25rem 0.625rem 0rem rgba(0, 0, 0, 0.2)',
  );
  check('px project: box shadow keeps px', style.writtenValue('box-shadow', style.serializeBoxShadows(shadows), PX), '0px 4px 8px 0px rgba(0, 0, 0, 0.2)');
  const blank = style.serializeBoxShadows([style.blankBoxShadow()]);
  check('rem project: a new box shadow has no px', /\dpx/.test(style.writtenValue('box-shadow', blank, REM)), false);

  // Outline: typed values, width and offset, and a negative offset kept negative.
  check('rem project: outline width typed as px', style.writtenValue('outline-width', '2px', REM), '0.125rem');
  check('rem project: outline offset negative', style.writtenValue('outline-offset', '-4px', REM), '-0.25rem');
  check('rem project: outline shorthand', style.writtenValue('outline', '1px solid var(--focus)', REM), '0.0625rem solid var(--focus)');
  check('px project: outline unchanged', style.writtenValue('outline-width', '2px', PX), '2px');

  // Spacing: a typed shorthand, the non-negative clamp still first, and a drag.
  check('rem project: padding shorthand', style.writtenValue('padding', '8px 16px', REM), '0.5rem 1rem');
  check('rem project: negative padding clamps to zero first', style.writtenValue('padding-top', '-8px', REM), '0');
  check('rem project: margin may be negative', style.writtenValue('margin-top', '-8px', REM), '-0.5rem');
  const press = { clientX: 100, clientY: 100 };
  const shown = { value: '16px', important: false };
  useHost(REM);
  const remDrag = style.startSideDrag({ side: 'top', shown, inward: true, threshold: 0, event: press });
  check('rem project: a px side drags in rem', remDrag.unit, 'rem');
  check('rem project: the drag starts at the same length', remDrag.startAmount, 1);
  check('rem project: drag lengths round to whole pixels', style.formatLength(1.04, 'rem', REM), '1.0625rem');
  useHost(PX);
  const pxDrag = style.startSideDrag({ side: 'top', shown, inward: true, threshold: 0, event: press });
  check('px project: a px side drags in px', pxDrag.unit, 'px');
  check('px project: rem drags keep hundredths', style.formatLength(1.03, 'rem', PX), '1.03rem');

  // Arrow steps and scrubs: pixel steps in rem, px read as rem from the first step.
  const step = (text, mode, unit) => style.stepNumberAtCaret(text, 1, 1, mode, undefined, 1, unit);
  check('rem project: arrow up on 12px', step('12px', 'whole', REM).text, '0.8125rem');
  check('rem project: arrow up on 1.5rem moves one pixel', step('1.5rem', 'whole', REM).text, '1.5625rem');
  check('rem project: shift-arrow moves ten pixels', step('1.25rem', 'ten', REM).text, '1.875rem');
  // The caret sat one character into `px`; it stays one character into `rem`.
  check('rem project: caret stays in the unit it was in', style.stepNumberAtCaret('12px solid', 3, 1, 'whole', undefined, 1, REM).caret, 7);
  check('px project: arrow up on 12px', step('12px', 'whole', PX).text, '13px');
  check('px project: arrow up on 1.5rem snaps to the next whole rem', step('1.5rem', 'whole', PX).text, '2rem');
  check('rem project: em is left in em', step('1em', 'whole', REM).text, '2em');
  const run = style.findScrubTarget('0 4px 8px black', 3);
  check('rem project: scrub a px run writes rem', style.scrubNumber('0 4px 8px black', run, 2, 'whole', 1, REM), '0 0.375rem 8px black');
  check('px project: scrub a px run keeps px', style.scrubNumber('0 4px 8px black', run, 2, 'whole', 1, PX), '0 6px 8px black');

  // Transform move: px reads as rem, and the slider notches in pixels.
  const axis = style.projectAxis(style.parseAxis('8px', 'rem'), REM);
  check('rem project: a px move reads as rem', `${axis.num}${axis.unit}`, '0.5rem');
  check('rem project: move notches per pixel', style.projectAxisConfig('move', REM).steps, 16);
  check('px project: move keeps hundredths', style.projectAxisConfig('move', PX).steps, 100);

  if (failures.length > 0) {
    console.error(`length unit writes: ${failures.length} of ${checked} checks failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`length unit writes: ${checked} checks passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
