// What a doc comment is allowed to promise a field.
//
//   node test/doc-defaults.js
//
// A prop's fallback is often only written down in prose: `/** Output format.
// Defaults to `webp`. */`. Reading it gives a field its placeholder, so the
// panel can say what happens when you leave the field alone.
//
// The care is in what must NOT be read that way. "Defaults to `webp`, or
// `svg` for SVG sources" names two values and which one applies depends on a
// prop the panel cannot see. A placeholder is read as fact, so a clause with
// two answers becomes a hint and no value is claimed.
//
// That used to be decided by the words joining the two — for, when, if, on —
// and a doc reading "Defaults to `Play`, or `Pause` while pressed" was taken
// as a plain default of Play. The panel then offered Play as the placeholder
// on a close button, whose label defaults to Close. Counting the values the
// clause names does not depend on guessing which words a sentence might use.

const { parsePropSchema } = require('../electron/astroParser.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const schemaFor = (doc) =>
  parsePropSchema(
    `---\ninterface Props {\n  /** ${doc} */\n  thing?: string;\n}\nconst { thing } = Astro.props;\n---\n<div>{thing}</div>\n`
  );

const field = (doc) => {
  const schema = schemaFor(doc);
  const list = Array.isArray(schema) ? schema : [...(schema?.values?.() ?? [])];
  return list.find((f) => f.name === 'thing') || {};
};

// One value, stated plainly: taken as the placeholder.
const plain = field('Output format. Defaults to `webp`.');
check('a single value becomes the default', plain.default === 'webp', JSON.stringify(plain));
check('a single value claims no hint', !plain.hint, JSON.stringify(plain));

// Two values: no default may be claimed, whatever joins them.
for (const [label, doc] of [
  ['for', 'Output format. Defaults to `webp`, or `svg` for SVG sources.'],
  ['when', 'What it says. Defaults to `Play`, or `Pause` when pressed.'],
  ['while', 'What it says. Defaults to `Play`, or `Pause` while pressed.'],
  ['going', 'Which way. Defaults to `Next`, or `Previous` going back.'],
  ['plain or', 'Which way. Defaults to `Next`, or `Previous`.'],
]) {
  const f = field(doc);
  check(`two values claim no default — ${label}`, f.default === undefined, JSON.stringify(f));
  check(`two values leave a hint — ${label}`, !!f.hint, JSON.stringify(f));
}

// Prose naming one value still needs a joining word to read as conditional.
const prose = field('Output format. Defaults to webp or svg for SVG sources.');
check('unbackticked prose still reads as conditional', prose.default === undefined, JSON.stringify(prose));

// A decimal inside backticks is one value, not a sentence that ended early.
const decimal = field('How far. Defaults to `1.5`.');
check('a decimal is one value', decimal.default === 1.5 || decimal.default === '1.5', JSON.stringify(decimal));

// A prop written in several branches of a union has one answer per branch,
// and the branch is decided by props the panel already knows. The field
// itself still claims nothing.
const union = parsePropSchema(
  [
    '---',
    'type Props =',
    '  | {',
    '      variant: "play";',
    '      /** What it says. Defaults to `Play`. */',
    '      label?: string;',
    '    }',
    '  | {',
    '      variant: "close";',
    '      /** What it says. Defaults to `Close`. */',
    '      label?: string;',
    '    };',
    'const { variant, label } = Astro.props;',
    '---',
    '<button>{label}{variant}</button>',
  ].join('\n')
);
const unionList = Array.isArray(union) ? union : [...(union?.values?.() ?? [])];
const labelField = unionList.find((f) => f.name === 'label') || {};
const table = (labelField.unions || []).find((u) => u.names.includes('label'));

check('the field claims no default of its own', labelField.default === undefined, JSON.stringify(labelField.default));
check('the union is reported', !!table, JSON.stringify(labelField.unions));
if (table) {
  const byVariant = {};
  for (const b of table.branches) {
    const pinned = (b.pins.variant || [])[0];
    if (pinned) byVariant[pinned] = b.defaults?.label;
  }
  check('play branch falls back to Play', byVariant.play === 'Play', JSON.stringify(byVariant));
  check('close branch falls back to Close', byVariant.close === 'Close', JSON.stringify(byVariant));
}

// A clause that names the prop it turns on is a rule, not just a warning that
// there are two answers. The panel holds that prop's value already, so it can
// weigh the rule and show the answer that actually applies.
const ruleFor = (doc) => {
  const src = [
    '---',
    'type Props =',
    '  | {',
    '      variant: "arrow";',
    `      /** ${doc} */`,
    '      label?: string;',
    '      direction?: "forward" | "back";',
    '    }',
    '  | { variant: "close"; label?: string; direction?: never };',
    'const { variant, label, direction } = Astro.props;',
    '---',
    '<button>{label}{variant}{direction}</button>',
  ].join('\n');
  const list = [...parsePropSchema(src).values()];
  const table = (list.find((f) => f.name === 'label')?.unions || []).find((u) => u.names.includes('label'));
  const arrow = (table?.branches || []).find((b) => (b.pins.variant || []).includes('arrow'));
  return arrow?.rules?.label;
};

const named = ruleFor('What it says. Defaults to `Next`, or `Previous` when direction is `back`.');
check('a named condition becomes a rule', !!named, JSON.stringify(named));
if (named) {
  check('the rule reads its prop', named.prop === 'direction', JSON.stringify(named));
  check('the rule reads the value it turns on', named.is === 'back', JSON.stringify(named));
  check('the rule reads both answers', named.then === 'Previous' && named.otherwise === 'Next', JSON.stringify(named));
}

const bare = ruleFor('What it says. Defaults to `Play`, or `Pause` when pressed.');
check('a bare boolean condition reads as true', bare && bare.prop === 'pressed' && bare.is === 'true', JSON.stringify(bare));

// A clause with two answers but no prop named stays a hint, since there is
// nothing to weigh it against.
const vague = ruleFor('What it says. Defaults to `Next`, or `Previous` for the other way.');
check('an unnamed condition stays a hint', !vague, JSON.stringify(vague));

// The tip beside a field describes the prop, and a prop is one thing however
// many branches declare it. Where the branches' docs part is the fallback,
// which the placeholder already answers for the branch in force — so the tip
// shows what they all say and stops there.
const shared = parsePropSchema(
  [
    '---',
    'type Props =',
    '  | {',
    '      variant: "play";',
    '      /** What it says. Defaults to `Play`. */',
    '      label?: string;',
    '    }',
    '  | {',
    '      variant: "close";',
    '      /** What it says. Defaults to `Close`. */',
    '      label?: string;',
    '    };',
    'const { variant, label } = Astro.props;',
    '---',
    '<button>{label}{variant}</button>',
  ].join('\n')
);
const sharedLabel = [...shared.values()].find((f) => f.name === 'label') || {};
check(
  'the tip keeps what every branch says',
  sharedLabel.doc === 'What it says.',
  JSON.stringify(sharedLabel.doc)
);

// One branch, one doc: nothing is trimmed.
const single = parsePropSchema(
  [
    '---',
    'interface Props {',
    '  /** Output format. Defaults to `webp`. */',
    '  format?: string;',
    '}',
    'const { format } = Astro.props;',
    '---',
    '<img alt="" data-f={format} />',
  ].join('\n')
);
const only = [...single.values()].find((f) => f.name === 'format') || {};
check(
  'a prop declared once keeps its whole doc',
  only.doc === 'Output format. Defaults to `webp`.',
  JSON.stringify(only.doc)
);

if (failures.length) {
  console.error(`\ndoc-defaults: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`doc-defaults: ${checked} passed  [one value, two values, prose]`);
