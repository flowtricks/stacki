// Goal: every variant rule edit writes the smallest text change that says it,
// keeps the runtime type, the destructure and the controller's comparisons in
// step in the same write, leaves every other byte (comments, formatting,
// unrelated unions) as it was, and refuses what it cannot write faithfully
// instead of leaving the component's code wrong.
// Method: round trips on the Lumos Button fixture: parse, apply one edit, and
// compare the whole output with the fixture plus the exact replacements the
// edit should make (`replaced`, which insists each replaced text occurs once).
// Then small components for formatting the fixture does not have (one line,
// commas, single quotes, no runtime type), and the negative space: read-only
// groups, unknown names, bad values, options the code uses in ways the writer
// cannot follow, the last options and the fallback.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { editVariantRules } from '#dist/electron/properties/variantRuleEdits.js';
import { readVariantGroups } from '#dist/electron/properties/variantRuleModel.js';
import type { VariantRuleEdit } from '#dist/shared/properties/variantRules.js';

// The gate runs every suite from the repository root.
const BUTTON = fs.readFileSync('test/fixtures/variantRules/Button.astro', 'utf8');

function replaced(source: string, replacements: readonly (readonly [string, string])[]): string {
  let output = source;
  for (const [from, to] of replacements) {
    assert.equal(output.split(from).length, 2, `expected exactly one ${JSON.stringify(from)}`);
    output = output.replace(from, () => to);
  }
  return output;
}

function edited(source: string, edit: VariantRuleEdit): string {
  const result = editVariantRules(source, edit);
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  return result.value;
}

function refused(source: string, edit: VariantRuleEdit): string {
  const result = editVariantRules(source, edit);
  assert.equal(result.ok, false, 'expected a refusal');
  return result.ok ? '' : result.error.code;
}

function component(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n<div />\n`;
}

const MAIN_TAIL = '      label?: never;\n      pressed?: never;\n      direction?: never;\n    }\n  | {\n      variant: "link";';
const PLAY_LABEL = 'Defaults to `Play` or `Pause`. */\n      label?: string;';
const ARROW_DIRECTION = '/** Arrow direction. */\n      direction?: "forward" | "back";';
const RUNTIME_VARIANT = 'variant?: "main" | "link" | "play" | "close" | "arrow";';

test('setRule: Not allowed to Allowed takes the prop type the first allowing option writes', () => {
  const output = edited(BUTTON, { kind: 'setRule', controller: 'variant', option: 'main', prop: 'label', state: 'optional' });
  assert.equal(output, replaced(BUTTON, [[MAIN_TAIL, MAIN_TAIL.replace('label?: never;', 'label?: string;')]]));
});

test('setRule: Allowed to Required takes the question mark away, keeping the comment', () => {
  const output = edited(BUTTON, { kind: 'setRule', controller: 'variant', option: 'play', prop: 'label', state: 'required' });
  assert.equal(output, replaced(BUTTON, [[PLAY_LABEL, PLAY_LABEL.replace('label?:', 'label:')]]));
});

test('setRule: Allowed to Not allowed writes never and leaves the runtime type alone', () => {
  const output = edited(BUTTON, { kind: 'setRule', controller: 'variant', option: 'arrow', prop: 'direction', state: 'forbidden' });
  assert.equal(output, replaced(BUTTON, [[ARROW_DIRECTION, '/** Arrow direction. */\n      direction?: never;']]));
});

test('setRule: a shared alias type comes back as written', () => {
  const output = edited(BUTTON, { kind: 'setRule', controller: 'variant', option: 'link', prop: 'emphasis', state: 'optional' });
  assert.equal(output, replaced(BUTTON, [['quietest. */\n      emphasis?: never;', 'quietest. */\n      emphasis?: Emphasis;']]));
});

test('setRule: Not allowed to Required in the element group', () => {
  const output = edited(BUTTON, { kind: 'setRule', controller: 'element', option: 'link', prop: 'disabled', state: 'required' });
  assert.equal(output, replaced(BUTTON, [['      type?: never;\n      disabled?: never;', '      type?: never;\n      disabled: boolean;']]));
});

test('setRule: the state it already has changes nothing', () => {
  assert.equal(edited(BUTTON, { kind: 'setRule', controller: 'variant', option: 'main', prop: 'label', state: 'forbidden' }), BUTTON);
  assert.equal(edited(BUTTON, { kind: 'setRule', controller: 'variant', option: 'play', prop: 'label', state: 'optional' }), BUTTON);
});

test('addOption: copies the last option, renames it, and lists it in the runtime type', () => {
  const output = edited(BUTTON, { kind: 'addOption', controller: 'variant', value: 'ghost' });
  const arrow = [
    '  | {',
    '      variant: "arrow";',
    '      emphasis?: Emphasis;',
    '      /** Accessible label. Defaults to `Next` or `Previous`. */',
    '      label?: string;',
    '      pressed?: never;',
    '      /** Arrow direction. */',
    '      direction?: "forward" | "back";',
    '    }',
  ].join('\n');
  assert.equal(
    output,
    replaced(BUTTON, [
      [`${arrow};`, `${arrow}\n${arrow.replace('"arrow"', '"ghost"')};`],
      [RUNTIME_VARIANT, 'variant?: "main" | "link" | "play" | "close" | "arrow" | "ghost";'],
    ]),
  );
  const variant = readVariantGroups(output).find((group) => group.controller === 'variant');
  assert.deepEqual(
    variant?.options.map((option) => [option.value, option.fallback]),
    [
      ['main', true],
      ['link', false],
      ['play', false],
      ['close', false],
      ['arrow', false],
      ['ghost', false],
    ],
  );
});

test('addOption: copying the fallback drops its question mark, attributes pass through', () => {
  const source = component(
    ['type Props =', '  | (HTMLAttributes<"a"> & { tag: "a"; href?: string })', '  | (HTMLAttributes<"button"> & { tag?: "button" });'].join('\n'),
  );
  const output = edited(source, { kind: 'addOption', controller: 'tag', value: 'span' });
  assert.equal(
    output,
    replaced(source, [
      [
        '  | (HTMLAttributes<"button"> & { tag?: "button" });',
        '  | (HTMLAttributes<"button"> & { tag?: "button" })\n  | (HTMLAttributes<"button"> & { tag: "span" });',
      ],
    ]),
  );
});

test('renameOption: the union, the runtime type, the default and every comparison', () => {
  const output = edited(BUTTON, { kind: 'renameOption', controller: 'variant', from: 'main', to: 'primary' });
  assert.equal(
    output,
    replaced(BUTTON, [
      ['/** Button type. */\n      variant?: "main";', '/** Button type. */\n      variant?: "primary";'],
      [RUNTIME_VARIANT, RUNTIME_VARIANT.replace('"main"', '"primary"')],
      ['  variant = "main",', '  variant = "primary",'],
      ['const isWritten = variant === "main" ||', 'const isWritten = variant === "primary" ||'],
      ['variant !== "main" && variant,', 'variant !== "primary" && variant,'],
    ]),
  );
});

test('renameOption: an option another group shares keeps its other meaning', () => {
  const output = edited(BUTTON, { kind: 'renameOption', controller: 'variant', from: 'link', to: 'text' });
  assert.equal(
    output,
    replaced(BUTTON, [
      ['  | {\n      variant: "link";', '  | {\n      variant: "text";'],
      [RUNTIME_VARIANT, RUNTIME_VARIANT.replace('"link"', '"text"')],
      ['|| variant === "link";', '|| variant === "text";'],
    ]),
  );
  assert.ok(output.includes('element: "link";'));
  assert.ok(output.includes('element === "link"'));
});

test('renameOption and removeOption: refused where the code names the option as a key', () => {
  assert.equal(refused(BUTTON, { kind: 'renameOption', controller: 'variant', from: 'play', to: 'start' }), 'in-use');
  assert.equal(refused(BUTTON, { kind: 'removeOption', controller: 'variant', value: 'close' }), 'in-use');
  // `variant === "link"` would be left comparing against an option that is gone.
  assert.equal(refused(BUTTON, { kind: 'removeOption', controller: 'variant', value: 'link' }), 'in-use');
});

test('removeOption: the fallback and the last two options stay', () => {
  assert.equal(refused(BUTTON, { kind: 'removeOption', controller: 'variant', value: 'main' }), 'fallback');
  assert.equal(refused(BUTTON, { kind: 'removeOption', controller: 'element', value: 'link' }), 'limit');
});

const SMALL = component(
  [
    'type Props =',
    '  | { tone?: "calm"; icon?: never }',
    '  | { tone: "loud"; icon?: string }',
    '  | { tone: "quiet"; icon?: never };',
    'const { tone = "calm", icon } = Astro.props;',
  ].join('\n'),
);

test('removeOption: a member and its separator, first or not', () => {
  assert.equal(
    edited(SMALL, { kind: 'removeOption', controller: 'tone', value: 'loud' }),
    replaced(SMALL, [['  | { tone?: "calm"; icon?: never }\n  | { tone: "loud"; icon?: string }', '  | { tone?: "calm"; icon?: never }']]),
  );
  const first = replaced(SMALL, [
    ['tone?: "calm"', 'tone: "calm"'],
    ['tone: "quiet"', 'tone?: "quiet"'],
    ['tone = "calm"', 'tone = "quiet"'],
  ]);
  assert.equal(edited(first, { kind: 'removeOption', controller: 'tone', value: 'calm' }), replaced(first, [['{ tone: "calm"; icon?: never }\n  | ', '']]));
});

test('moveOption: members swap text in place, the runtime type follows', () => {
  const output = edited(BUTTON, { kind: 'moveOption', controller: 'variant', value: 'arrow', index: 0 });
  const groups = readVariantGroups(output);
  assert.deepEqual(
    groups.find((group) => group.controller === 'variant')?.options.map((option) => option.value),
    ['arrow', 'main', 'link', 'play', 'close'],
  );
  assert.ok(output.includes('variant?: "arrow" | "main" | "link" | "play" | "close";'));
  // Only the Kind union and the runtime line differ: the rest keeps its bytes.
  const head = BUTTON.indexOf('type Kind =');
  assert.equal(output.slice(0, head), BUTTON.slice(0, head));
  assert.equal(output.slice(output.indexOf('const {')), BUTTON.slice(BUTTON.indexOf('const {')));
  assert.equal(edited(BUTTON, { kind: 'moveOption', controller: 'variant', value: 'main', index: 0 }), BUTTON);
  assert.equal(refused(BUTTON, { kind: 'moveOption', controller: 'variant', value: 'main', index: 5 }), 'order');
});

test('setFallback: the question mark moves and the destructure default follows', () => {
  const output = edited(BUTTON, { kind: 'setFallback', controller: 'variant', value: 'play' });
  assert.equal(
    output,
    replaced(BUTTON, [
      ['variant?: "main";', 'variant: "main";'],
      ['variant: "play";', 'variant?: "play";'],
      ['  variant = "main",', '  variant = "play",'],
    ]),
  );
  assert.equal(edited(BUTTON, { kind: 'setFallback', controller: 'variant', value: 'main' }), BUTTON);
});

test('addProp: every option, the runtime type and the destructure, before ...rest', () => {
  const output = edited(BUTTON, { kind: 'addProp', controller: 'variant', prop: 'icon', type: 'string' });
  const kind = BUTTON.slice(BUTTON.indexOf('type Kind ='), BUTTON.indexOf('type Props ='));
  const kindAfter = kind.replace(/(\n {6}direction\?: [^\n]+;)(\n {4}\})/g, '$1\n      icon?: string;$2');
  assert.equal(
    output,
    replaced(BUTTON, [
      [kind, kindAfter],
      ['    type?: "button" | "submit" | "reset";\n  };', '    type?: "button" | "submit" | "reset";\n    icon?: string;\n  };'],
      ['  class: className,\n  ...rest', '  class: className,\n  icon,\n  ...rest'],
    ]),
  );
  assert.equal(kindAfter.split('icon?: string;').length, 6);
  assert.equal(refused(BUTTON, { kind: 'addProp', controller: 'variant', prop: 'label', type: 'string' }), 'duplicate');
  assert.equal(refused(BUTTON, { kind: 'addProp', controller: 'variant', prop: 'isLink', type: 'string' }), 'binding');
  assert.equal(refused(BUTTON, { kind: 'addProp', controller: 'variant', prop: 'icon', type: 'string |' }), 'type');
});

test('removeProp: refused while the code reads it; else every declaration and the local go', () => {
  assert.equal(refused(BUTTON, { kind: 'removeProp', controller: 'variant', prop: 'pressed' }), 'in-use');
  assert.equal(
    edited(SMALL, { kind: 'removeProp', controller: 'tone', prop: 'icon' }),
    replaced(SMALL, [
      ['{ tone?: "calm"; icon?: never }', '{ tone?: "calm"; }'],
      ['{ tone: "loud"; icon?: string }', '{ tone: "loud"; }'],
      ['{ tone: "quiet"; icon?: never }', '{ tone: "quiet"; }'],
      ['const { tone = "calm", icon }', 'const { tone = "calm" }'],
    ]),
  );
});

test('one-line members: a new declaration joins the line with its separator', () => {
  assert.equal(
    edited(SMALL, { kind: 'setRule', controller: 'tone', option: 'calm', prop: 'icon', state: 'required' }),
    replaced(SMALL, [['{ tone?: "calm"; icon?: never }', '{ tone?: "calm"; icon: string }']]),
  );
  const unlisted = component(
    ['type Props =', "  | { tone?: 'calm', size?: number }", "  | { tone: 'loud' };", 'const { tone, size } = Astro.props;'].join('\n'),
  );
  assert.equal(
    edited(unlisted, { kind: 'setRule', controller: 'tone', option: 'loud', prop: 'size', state: 'optional' }),
    replaced(unlisted, [["{ tone: 'loud' }", "{ tone: 'loud'; size?: number }"]]),
  );
  assert.equal(
    edited(unlisted, { kind: 'addOption', controller: 'tone', value: 'soft' }),
    replaced(unlisted, [["  | { tone: 'loud' };", "  | { tone: 'loud' }\n  | { tone: 'soft' };"]]),
  );
  // The prop is unlisted in "loud": setting it Not allowed there is already true.
  assert.equal(edited(unlisted, { kind: 'setRule', controller: 'tone', option: 'loud', prop: 'size', state: 'forbidden' }), unlisted);
});

test('no runtime type: the union and the destructure are the only declarations', () => {
  const output = edited(SMALL, { kind: 'addProp', controller: 'tone', prop: 'size', type: '"s" | "l"' });
  assert.equal(
    output,
    replaced(SMALL, [
      ['{ tone?: "calm"; icon?: never }', '{ tone?: "calm"; icon?: never; size?: "s" | "l" }'],
      ['{ tone: "loud"; icon?: string }', '{ tone: "loud"; icon?: string; size?: "s" | "l" }'],
      ['{ tone: "quiet"; icon?: never }', '{ tone: "quiet"; icon?: never; size?: "s" | "l" }'],
      ['const { tone = "calm", icon }', 'const { tone = "calm", icon, size }'],
    ]),
  );
});

test('refusals: unknown group, option and prop, bad and repeated values, read-only groups', () => {
  assert.equal(refused(BUTTON, { kind: 'addOption', controller: 'size', value: 'large' }), 'missing');
  assert.equal(refused(BUTTON, { kind: 'setRule', controller: 'variant', option: 'huge', prop: 'label', state: 'optional' }), 'missing');
  assert.equal(refused(BUTTON, { kind: 'setRule', controller: 'variant', option: 'main', prop: 'href', state: 'optional' }), 'missing');
  assert.equal(refused(BUTTON, { kind: 'addOption', controller: 'variant', value: 'play' }), 'duplicate');
  assert.equal(refused(BUTTON, { kind: 'addOption', controller: 'variant', value: 'gh"ost' }), 'option');
  assert.equal(refused(BUTTON, { kind: 'renameOption', controller: 'variant', from: 'arrow', to: 'close' }), 'duplicate');
  const exported = component(
    ['type Props = Kind;', 'export type Kind =', '  | { variant?: "a"; label?: never }', '  | { variant: "b"; label?: string };'].join('\n'),
  );
  assert.equal(refused(exported, { kind: 'setRule', controller: 'variant', option: 'a', prop: 'label', state: 'optional' }), 'restricted');
  const never = component(['type Props =', '  | { kind?: "a"; extra?: never }', '  | { kind: "b"; extra?: never };'].join('\n'));
  assert.equal(refused(never, { kind: 'setRule', controller: 'kind', option: 'a', prop: 'extra', state: 'optional' }), 'type');
});

test('every successful edit leaves source the reader models as editable', () => {
  const edits: readonly VariantRuleEdit[] = [
    { kind: 'setRule', controller: 'variant', option: 'close', prop: 'pressed', state: 'optional' },
    { kind: 'addOption', controller: 'element', value: 'submit' },
    { kind: 'moveOption', controller: 'element', value: 'link', index: 0 },
    { kind: 'setFallback', controller: 'element', value: 'link' },
    { kind: 'addProp', controller: 'element', prop: 'target', type: '"_blank" | "_self"' },
  ];
  let source = BUTTON;
  for (const edit of edits) {
    source = edited(source, edit);
    assert.deepEqual(
      readVariantGroups(source).map((group) => [group.controller, group.editing.kind]),
      [
        ['element', 'editable'],
        ['variant', 'editable'],
      ],
      edit.kind,
    );
  }
  assert.ok(source.includes('element?: "button" | "link" | "submit";') || source.includes('element?: "link" | "button" | "submit";'));
  assert.equal(source.slice(source.indexOf('\n---\n')), BUTTON.slice(BUTTON.indexOf('\n---\n')));
});

test('attachProp: a shared prop moves into every option, allowed where picked, with its comment', () => {
  const output = edited(BUTTON, { kind: 'attachProp', controller: 'element', prop: 'render', options: ['link'] });
  assert.equal(
    output,
    replaced(BUTTON, [
      ['type Props = {\n  /** Set to `false` to omit the component. */\n  render?: boolean;\n} & Tag &', 'type Props = {\n} & Tag &'],
      ['      href?: never;\n    })', '      href?: never;\n      render?: never;\n    })'],
      ['      disabled?: never;\n    });', '      disabled?: never;\n      /** Set to `false` to omit the component. */\n      render?: boolean;\n    });'],
    ]),
  );
  const element = readVariantGroups(output).find((group) => group.controller === 'element');
  assert.deepEqual(element?.props, ['type', 'disabled', 'href', 'render']);
  assert.deepEqual(element?.attachable, []);
  assert.equal(refused(BUTTON, { kind: 'attachProp', controller: 'element', prop: 'label', options: ['link'] }), 'missing');
  assert.equal(refused(BUTTON, { kind: 'attachProp', controller: 'element', prop: 'render', options: ['span'] }), 'missing');
});

test('detachProp: every option lets go, and the prop is declared once where all options share it', () => {
  const output = edited(BUTTON, { kind: 'detachProp', controller: 'variant', prop: 'label' });
  const kind = output.slice(output.indexOf('type Kind ='), output.indexOf('type Props ='));
  assert.doesNotMatch(kind, /label/);
  assert.match(output, /render\?: boolean;\n {2}\/\*\* Accessible label\. Defaults to `Play` or `Pause`\. \*\/\n {2}label\?: string;\n\} & Tag &/);
  const variant = readVariantGroups(output).find((group) => group.controller === 'variant');
  assert.deepEqual(variant?.props, ['emphasis', 'pressed', 'direction']);
  assert.ok(variant?.attachable.includes('label'));
  // Detaching and attaching again gives the prop the same allowed options.
  const back = edited(output, { kind: 'attachProp', controller: 'variant', prop: 'label', options: ['play', 'close', 'arrow'] });
  assert.deepEqual(
    readVariantGroups(back)
      .find((group) => group.controller === 'variant')
      ?.options.map((option) => option.rules.find((rule) => rule.prop === 'label')?.state),
    ['forbidden', 'forbidden', 'optional', 'optional', 'optional'],
  );
});

test('detachProp: with no shared object type, Props gains one', () => {
  const source = component(
    [
      'type Props = Kind;',
      'type Kind =',
      '  | { variant?: "a"; label: string }',
      '  | { variant: "b"; label: string };',
      'const { variant, label } = Astro.props;',
    ].join('\n'),
  );
  assert.equal(
    edited(source, { kind: 'detachProp', controller: 'variant', prop: 'label' }),
    replaced(source, [
      ['type Props = Kind;', 'type Props = { label: string } & Kind;'],
      ['  | { variant?: "a"; label: string }', '  | { variant?: "a"; }'],
      ['  | { variant: "b"; label: string };', '  | { variant: "b"; };'],
    ]),
  );
});

test('attachProp on a component with no group: a prop of string options becomes the controller', () => {
  const source = component(
    ['type Props = {', '  size?: "s" | "l";', '  /** Icon name. */', '  icon?: string;', '};', 'const { size = "l", icon } = Astro.props;'].join('\n'),
  );
  const groups = readVariantGroups(source);
  assert.deepEqual(
    groups.map((group) => [group.controller, group.editing.kind, group.options.map((option) => [option.value, option.fallback]), group.attachable]),
    [
      [
        'size',
        'candidate',
        [
          ['s', false],
          ['l', true],
        ],
        ['icon'],
      ],
    ],
  );
  const output = edited(source, { kind: 'attachProp', controller: 'size', prop: 'icon', options: ['s'] });
  assert.equal(
    output,
    replaced(source, [
      [
        'type Props = {\n  size?: "s" | "l";\n  /** Icon name. */\n  icon?: string;\n};',
        'type Props = {\n} & (\n  | { size: "s"; /** Icon name. */ icon?: string }\n  | { size?: "l"; icon?: never }\n);',
      ],
    ]),
  );
  assert.deepEqual(
    readVariantGroups(output).map((group) => [group.controller, group.editing.kind, group.props]),
    [['size', 'editable', ['icon']]],
  );
  assert.equal(refused(source, { kind: 'setRule', controller: 'size', option: 's', prop: 'icon', state: 'optional' }), 'missing');
  const exported = component(['export type Props = { size?: "s" | "l"; icon?: string };'].join('\n'));
  assert.deepEqual(readVariantGroups(exported), []);
});
