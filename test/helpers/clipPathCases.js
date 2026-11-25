// The inputs the clip-path characterization runs, and running them against the
// editor's functions (test/renderer/style/clipPathModel.test.js). The expected
// outputs were recorded from ClipPath.tsx as one file, before it was split, so
// the split is held to what the editor did rather than to what it now does.
const CSS_VALUES = [
  'none',
  'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)',
  'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',
  'polygon(evenodd, 10px 10px, 90% 10px, 50% 90%)',
  'polygon(20% 0%, 80% 0%, 100% 20%, 100% 80%, 80% 100%, 20% 100%, 0% 80%, 0% 20%)',
  'circle(50% at 50% 50%)',
  'circle(40px at 30% 70%)',
  'circle(closest-side at center)',
  'circle()',
  'ellipse(50% 30% at 50% 50%)',
  'ellipse(25% 40% at 20px 30px)',
  'ellipse(farthest-side closest-side)',
  'inset(10%)',
  'inset(10px 20%)',
  'inset(5% 10% 15% 20% round 8px)',
  'inset(0 round 10% 20% 30% 40% / 5px 6px)',
  'inset(calc(10% + 4px) 0)',
  'inset(var(--gap, 10px))',
  'polygon(var(--x, 0%) 0%, 100% 0%, 50% 100%)',
  'circle(10cqw at 50cqw 50cqh)',
  'path("M 0 0 L 100 0 L 50 100 Z")',
  'shape(from 0% 0%, line to 100% 0%, line to 50% 100%, close)',
  'shape(from 10px 10px, hline to 90%, vline to 90%, hline to 10%, close)',
  'shape(from 0% 50%, curve to 100% 50% with 50% 0%, curve to 0% 50% with 50% 100%, close)',
  'shape(from 0% 0%, arc to 100% 100% of 50% cw, close)',
  'url(#clip)',
  'margin-box',
  'circle(50%) border-box',
  'polygon(0 0, 100% 0)',
  'polygon(',
  'circle(at)',
  'inset()',
  'ellipse(1 2 3)',
  'banana',
  '',
  '   polygon( 0% 0% ,100% 0%,50% 100% )   ',
  'POLYGON(0% 0%, 100% 0%, 50% 100%)',
  'inset(10px) !important',
];

const SVGS = [
  '<svg viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80"/></svg>',
  '<svg viewBox="0 0 200 100"><circle cx="100" cy="50" r="40"/></svg>',
  '<svg viewBox="0 0 100 100"><ellipse cx="50" cy="50" rx="40" ry="20"/></svg>',
  '<svg viewBox="0 0 100 100"><polygon points="50,0 100,100 0,100"/></svg>',
  '<svg viewBox="0 0 100 100"><path d="M10 10 L90 10 L90 90 L10 90 Z"/></svg>',
  '<svg viewBox="0 0 100 100"><path d="M10 50 C10 10 90 10 90 50 S10 90 10 50 Z"/></svg>',
  '<svg viewBox="0 0 100 100"><path d="M10 50 A40 40 0 0 1 90 50 A40 40 0 0 1 10 50 Z"/></svg>',
  '<svg viewBox="0 0 100 100"><path d="M10 10 Q50 0 90 10 T90 90 H10 V10 z"/></svg>',
  '<svg viewBox="0 0 100 100"><rect x="0" y="0" width="50" height="50"/>' + '<rect x="50" y="50" width="50" height="50"/></svg>',
  '<svg viewBox="0 0 100 100"><g transform="translate(5 5)">' + '<rect width="10" height="10"/></g></svg>',
  '<svg width="64" height="32"><rect x="4" y="4" width="56" height="24" rx="4"/></svg>',
  '<svg viewBox="0 0 100 100"><defs><rect width="10" height="10"/></defs>' + '<circle cx="50" cy="50" r="10"/></svg>',
  '<svg viewBox="0 0 100 100"></svg>',
  'not svg at all',
  'M 0 0 L 100 0 L 100 100 Z',
];

const HANDLES = {
  polygon: [
    { kind: 'polygon-point', index: 0 },
    { kind: 'polygon-point', index: 2 },
  ],
  circle: [{ kind: 'circle-center' }, { kind: 'circle-radius' }],
  ellipse: [{ kind: 'ellipse-center' }, { kind: 'ellipse-rx' }, { kind: 'ellipse-ry' }],
  inset: [
    { kind: 'inset-top' },
    { kind: 'inset-right' },
    { kind: 'inset-bottom' },
    { kind: 'inset-left' },
    { kind: 'inset-radius', corner: 'topLeft' },
    { kind: 'inset-radius', corner: 'bottomRight' },
  ],
};
const DRAG_POINTS = [
  [0, 0],
  [25, 75],
  [50, 50],
  [110, -10],
];
const DRAG_OPTIONS = [{}, { insetSideMode: 'mirror', insetRadiusMode: 'all', ellipseScaleProportional: true }, { insetRadiusUnlocked: true }];
const KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'];
const KEY_OPTIONS = [{}, { step: 10 }, { polygonPointIndexes: [0, 1], step: 1 }];

// A value made comparable: functions are named, undefined becomes a marker so
// a key that went missing is told apart from one that was undefined.
function plain(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, inner) => {
      if (inner === undefined) {
        return '<undefined>';
      }
      if (typeof inner === 'function') {
        return '<function>';
      }
      if (typeof inner === 'number' && !Number.isFinite(inner)) {
        return String(inner);
      }
      return inner;
    }) ?? '"<undefined>"',
  );
}
function attempt(run) {
  try {
    return plain(run());
  } catch (error) {
    return { thrown: String(error && error.message ? error.message : error) };
  }
}

function handlesFor(shape) {
  return shape && HANDLES[shape.kind] ? HANDLES[shape.kind] : [];
}

function runCases(functions) {
  const out = { css: {}, svg: {}, fit: {} };
  for (const value of CSS_VALUES) {
    const shape = (() => {
      try {
        return functions.parseClipPath(value);
      } catch {
        return undefined;
      }
    })();
    const formatted = shape ? attempt(() => functions.formatClipPath(shape)) : undefined;
    const record = {
      parsed: attempt(() => functions.parseClipPath(value)),
      input: attempt(() => functions.parseClipPathInput(value)),
      normalized: attempt(() => functions.normalizeClipPathValue(value)),
    };
    if (shape) {
      const css = typeof formatted === 'string' ? formatted : value;
      record.formatted = formatted;
      record.reparsed = attempt(() => functions.parseClipPath(css));
      record.preview = attempt(() => functions.formatClipPathForPreview(shape, css, { width: 200, height: 100 }));
      record.previewNoSize = attempt(() => functions.formatClipPathForPreview(shape, css, undefined));
      record.highlights = attempt(() => functions.buildClipPathCodeHighlights(shape, css, ['a', 'b']));
      record.tokens = attempt(() => functions.clipPathValueTokenRanges(css, shape));
      record.preset = attempt(() => functions.matchPreset(shape));
      record.drags = handlesFor(shape).flatMap((handle) =>
        DRAG_POINTS.flatMap(([x, y]) =>
          DRAG_OPTIONS.map((options) =>
            attempt(() => functions.formatClipPath(functions.updateShapeForDrag(shape, { ...handle, before: shape }, x, y, options))),
          ),
        ),
      );
      record.keys = handlesFor(shape).flatMap((handle) =>
        KEYS.flatMap((key) =>
          KEY_OPTIONS.map((options) =>
            attempt(() => {
              const result = functions.updateShapeForKeyboard(shape, handle, key, options);
              return {
                css: functions.formatClipPath(result.shape),
                angle: result.circleRadiusAngle,
              };
            }),
          ),
        ),
      );
      if (shape.kind === 'shape') {
        for (const mode of ['stretch', 'contain']) {
          out.fit[`${value} -> ${mode}`] = attempt(() => {
            const converted = functions.convertShapeFitMode(shape, mode);
            return converted ? functions.formatClipPath(converted) : converted;
          });
        }
      }
    }
    out.css[value] = record;
  }
  for (const svg of SVGS) {
    for (const mode of ['stretch', 'contain']) {
      out.svg[`${mode}: ${svg}`] = attempt(() => {
        const shape = functions.parseSvgClipPathShape(svg, mode);
        return shape ? { shape, css: functions.formatClipPath(shape) } : shape;
      });
    }
  }
  return out;
}

const FUNCTION_NAMES = [
  'parseClipPath',
  'parseClipPathInput',
  'normalizeClipPathValue',
  'formatClipPath',
  'formatClipPathForPreview',
  'buildClipPathCodeHighlights',
  'clipPathValueTokenRanges',
  'matchPreset',
  'updateShapeForDrag',
  'updateShapeForKeyboard',
  'convertShapeFitMode',
  'parseSvgClipPathShape',
];

module.exports = { runCases, FUNCTION_NAMES };
