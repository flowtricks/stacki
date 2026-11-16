// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/components.json`: what a component brings with it when it is inserted (props, text or children), keyed by the
// component's file. The parser is shared/properties/componentDefaults.ts.
import { DEFAULT_LIMITS } from '../../componentDefaults';
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
      inherit: field(
        literal(false),
        "For a component child: false keeps it from inheriting that component's own defaults; the only value the parser accepts.",
        { commands: COMMANDS },
      ),
      props: propsField("The child's"),
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
  description: 'What each component brings along when it is inserted: default props, text or children. Shared by Desktop and Studio.',
  requires: 'component:edit',
  metadataKind: 'components',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    components: field(
      mapOf(
        objectOf({
          props: propsField("The component's"),
          text: textField("The component's"),
          children: field(
            arrayOf(childSchema, DEFAULT_LIMITS.childrenMax),
            `Children inserted inside, up to ${DEFAULT_LIMITS.childrenMax}; a recipe holds text or children, never both.`,
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
  parserSources: ['shared/properties/componentDefaults.ts'],
  parserKeyExceptions: {
    slot: 'A prop name inside a recipe (it places a child in a named slot), not a key of the file.',
  },
};
