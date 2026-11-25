// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/components.json`: what a component brings with it when it is inserted (props, text or children), keyed by the
// component's file. The parser is shared/properties/componentDefaults.ts.
import { DEFAULT_LIMITS, EDITING_FIELDS_MAX } from '../../componentDefaults';
import { DEFAULT_VALUE_LIMITS } from '../../componentDefaultValues';
import { arrayOf, field, jsonValue, literal, mapOf, objectOf, text, type FieldSchema, type FileSchema, type ValueSchema } from '../stackiSchema';

const COMPONENT_PATH = '^(?:src/|node_modules/(?:@[\\w.-]+/)?[\\w.-]+/)[\\w./ -]+\\.astro$';
// componentFile() in componentDefaults.ts bounds a path at this many characters but keeps the number inline, so it is mirrored here.
const COMPONENT_PATH_CHARS_MAX = 500;
const PROP_NAME = '^[A-Za-z_][\\w:-]{0,99}$';
const ELEMENT_NAME = '^[a-z][a-z0-9-]{0,99}$';
const COMMANDS = ['components rename', 'components move', 'components duplicate', 'components delete'] as const;

const propValue = jsonValue('a string, a finite number or a boolean; componentDefaults.ts defaultValue refuses any other value and text over its size bound');

const propsField = (what: string): FieldSchema =>
  field(
    mapOf(propValue, DEFAULT_LIMITS.propsMax, 'a prop name', PROP_NAME),
    `${what} prop values set on insertion; the prop "slot" places a child in a named slot.`,
    { commands: COMMANDS },
  );

const assetsField = (what: string): FieldSchema =>
  field(
    mapOf(
      objectOf({
        file: field(text(DEFAULT_VALUE_LIMITS.pathCharsMax, { charsMin: 1, pattern: '^src/' }), 'A media file under src/; insertion imports it.', {
          required: true,
          commands: COMMANDS,
        }),
        url: field(literal(true), "On: the prop reads the file's address (name.src), as for a plain <img> or a prop typed as text.", {
          commands: COMMANDS,
        }),
      }),
      DEFAULT_VALUE_LIMITS.entriesMax,
      'a prop name',
      PROP_NAME,
    ),
    `${what} props set to an imported file. A file in public/ or a hosted one is a string in props. A prop is set once, in props, assets or literals.`,
    { commands: COMMANDS },
  );

const literalsField = (what: string): FieldSchema =>
  field(
    mapOf(
      jsonValue(
        'the source of a list or object written as literal data, or {"source", "imports": {name: "src/…"}} where it names imported files; componentDefaultValues.ts refuses code',
      ),
      DEFAULT_VALUE_LIMITS.entriesMax,
      'a prop name',
      PROP_NAME,
    ),
    `${what} list and object props, written into the page as they are.`,
    { commands: COMMANDS },
  );

const textField = (what: string): FieldSchema =>
  field(text(DEFAULT_LIMITS.textCharsMax), `${what} text placed in the default slot; a recipe holds text or children, never both.`, { commands: COMMANDS });

/** Levels of children below the recipe's own list that are described; the DSL nests at most SCHEMA_LIMITS.depthMax levels. */
const CHILD_LEVELS_DESCRIBED = 2;

/**
 * One child of a recipe. A child holds exactly one of `component`, `element` or `literal` (the parser refuses any other count), so the
 * keys are listed side by side rather than as a tagged variant: the file carries no tag. Built from the deepest level outward in a loop
 * bounded by CHILD_LEVELS_DESCRIBED; the deepest `children` list is JSON that parseRecipeChildren checks up to DEFAULT_LIMITS.depthMax.
 */
function buildChildSchema(): ValueSchema {
  let children: ValueSchema = jsonValue(
    'a list of the same child shapes (component, element or literal); parseRecipeChildren in componentDefaults.ts checks it down to the recipe depth bound',
  );
  let child: ValueSchema = { kind: 'object', fields: {} };
  for (let level = 0; level < CHILD_LEVELS_DESCRIBED; level += 1) {
    child = objectOf({
      component: field(
        text(COMPONENT_PATH_CHARS_MAX, { charsMin: 1, pattern: COMPONENT_PATH }),
        'Makes this child a component: a project-relative .astro path (src/...) or one inside an installed package.',
        { commands: COMMANDS },
      ),
      element: field(text(100, { charsMin: 1, pattern: ELEMENT_NAME }), 'Makes this child an HTML element, such as div or p.', { commands: COMMANDS }),
      literal: field(text(DEFAULT_LIMITS.textCharsMax), 'Makes this child raw text placed as-is; nothing else may be set beside it.', { commands: COMMANDS }),
      tag: field(
        text(120, { charsMin: 1 }),
        'For an element child: the tag written instead of element, for Fragment, <>, an SVG element with capitals, or an Astro built-in with from.',
        { commands: COMMANDS },
      ),
      from: field(text(40, { pattern: '^astro:(components|assets)$' }), 'The module a built-in tag is imported from.', { commands: COMMANDS }),
      verbatim: field(text(DEFAULT_LIMITS.textCharsMax, { charsMin: 2 }), 'Beside an empty literal: a comment or static braces ({" "}) kept as written.', {
        commands: COMMANDS,
      }),
      inherit: field(
        literal(false),
        "For a component child: false keeps it from inheriting that component's own defaults; the only value the parser accepts.",
        { commands: COMMANDS },
      ),
      props: propsField("The child's"),
      assets: assetsField("The child's"),
      literals: literalsField("The child's"),
      text: textField("The child's"),
      children: field(children, `Children inserted inside, up to ${DEFAULT_LIMITS.childrenMax}; a recipe holds text or children, never both.`, {
        commands: COMMANDS,
      }),
    });
    children = arrayOf(child, DEFAULT_LIMITS.childrenMax);
  }
  return child;
}

const childSchema = buildChildSchema();

export const COMPONENTS_FILE: FileSchema = {
  id: 'components',
  file: '.stacki/components.json',
  description:
    'What each component brings along when it is inserted (default props, text or children) and how each field is typed in (editing: lineBreaks, richText). Shared by Desktop and Studio.',
  requires: 'component:edit',
  metadataKind: 'components',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    components: field(
      mapOf(
        objectOf({
          props: propsField("The component's"),
          assets: assetsField("The component's"),
          literals: literalsField("The component's"),
          text: textField("The component's"),
          children: field(
            arrayOf(childSchema, DEFAULT_LIMITS.childrenMax),
            `Children inserted inside, up to ${DEFAULT_LIMITS.childrenMax}; a recipe holds text or children, never both.`,
            { commands: COMMANDS },
          ),
          editing: field(
            mapOf(
              objectOf({
                lineBreaks: field(
                  literal(true),
                  'On: Enter types a line break (<br>) in this field, on the canvas and in the panel. Off is the key left out.',
                  {
                    commands: COMMANDS,
                  },
                ),
                richText: field(
                  literal(true),
                  'On: this field is edited as rich text (Enter starts a new paragraph, + changes a block, Edit rich text in the panel). Off is the key left out.',
                  { commands: COMMANDS },
                ),
              }),
              EDITING_FIELDS_MAX,
              'a prop name, or slot:<name> (slot:default for the content between the tags)',
              '^(?:[A-Za-z_$][\\w$]{0,99}|slot:[\\w-]{1,100})$',
            ),
            'How each field is typed in. Offered for slots and for props the template sets with set:html; check-project names a setting a field cannot take.',
            { commands: COMMANDS },
          ),
        }),
        DEFAULT_LIMITS.componentsMax,
        'a component file path',
        COMPONENT_PATH,
      ),
      'The insertion recipe of each component, keyed by its project-relative .astro path; at most 4096 recipe nodes across the file.',
      { required: true, commands: [...COMMANDS, 'components rename', 'components move', 'components duplicate', 'components delete'] },
    ),
  },
  empty: { version: 1, components: {} },
  commands: ['components rename', 'components move', 'components duplicate', 'components delete'],
  parserSources: ['shared/properties/componentDefaults.ts', 'shared/properties/componentDefaultValues.ts'],
  parserKeyExceptions: {
    slot: 'A prop name inside a recipe (it places a child in a named slot), not a key of the file.',
    source: 'Inside a literals value that names imported files; the value is described as JSON, and componentDefaultValues.ts checks it.',
    imports: 'Inside a literals value that names imported files; the value is described as JSON, and componentDefaultValues.ts checks it.',
  },
};
