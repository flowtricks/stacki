// i18n-ignore-file: the CLI and its MCP tools speak to agents and scripts in English; none of this is interface text.
// `.stacki/component-canvas.json`: the component canvas's layout and preview values, keyed by the component's file. The parser
// is shared/properties/componentCanvas.ts; preview values are what the canvas renders with and never reach the component.
import { CANVAS_LIMITS } from '../../componentCanvas';
import { arrayOf, field, jsonValue, literal, mapOf, objectOf, text, type FileSchema, type ValueSchema } from '../stackiSchema';

const COMPONENT_PATH = '^(?:src/|node_modules/)[^\\u0000]*\\.astro$';
const PROP_NAME = '^[A-Za-z_$][\\w$-]{0,99}$';
// Sorted `name` or `name=URI-encoded value` pairs joined by `&`; the empty key is every frame. parseFrameKey checks the order.
const FRAME_KEY = '^(?:[A-Za-z_$][\\w$-]*(?:=[^&]*)?(?:&[A-Za-z_$][\\w$-]*(?:=[^&]*)?)*)?$';
// A layout's level: the canvas, or a group's frame key (never empty, which is every frame).
const LEVEL_KEY = `^(?:\\*canvas|(?=.)${FRAME_KEY.slice(1, -1)})$`;
const COMMANDS = ['components rename', 'components move', 'components delete'] as const;
// componentCanvas.ts CLASS_NAME, bounded; `stacki-` names are the canvas's own and refused by the parser.
const CLASS_NAME = `^-?[A-Za-z_][\\w-]{0,${CANVAS_LIMITS.classNameCharsMax - 1}}$`;

const rootClasses: ValueSchema = arrayOf(text(CANVAS_LIMITS.classNameCharsMax, { pattern: CLASS_NAME }), CANVAS_LIMITS.rootClassesMax, { unique: true });

const rootBackground = text(CANVAS_LIMITS.backgroundCharsMax, { charsMin: 1 });

const length = (side: string): ValueSchema =>
  jsonValue(`"hug" (the ${side} follows the component) or a whole number of pixels from ${CANVAS_LIMITS.sizePxMin} to ${CANVAS_LIMITS.sizePxMax}`);

const frameEntry: ValueSchema = objectOf({
  props: field(
    mapOf(
      jsonValue('text, a finite number or true or false; componentCanvas.ts canvasValue refuses anything else'),
      CANVAS_LIMITS.valuesMax,
      'a prop name',
      PROP_NAME,
    ),
    'Preview values the frames this entry covers render with. They are never written to the component or its instances.',
  ),
  unset: field(
    arrayOf(text(CANVAS_LIMITS.propNameCharsMax, { pattern: PROP_NAME }), CANVAS_LIMITS.valuesMax, { unique: true }),
    'Props shown as not set here, over a wider entry.',
  ),
  assets: field(
    mapOf(
      jsonValue('{ "file": "src/assets/hero.png" }, plus "url": true where the page reads its address (name.src)'),
      CANVAS_LIMITS.valuesMax,
      'a prop name',
      PROP_NAME,
    ),
    'Imported files under src/ that props preview with, as .stacki/components.json holds asset defaults.',
  ),
  literals: field(
    mapOf(
      jsonValue('a list or object of plain data as source text, or { "source": "...", "imports": { "name": "src/..." } }'),
      CANVAS_LIMITS.valuesMax,
      'a prop name',
      PROP_NAME,
    ),
    'Lists and objects that props preview with, as .stacki/components.json holds literal defaults. Read as data, never run.',
  ),
  content: field(
    text(CANVAS_LIMITS.contentCharsMax),
    'The default slot markup these frames show: HTML with no script, style or event handler; "" is an empty slot.',
  ),
  width: field(length('width'), 'The frame width; absent: a wider entry decides, else hug.'),
  height: field(length('height'), 'The frame height; absent: a wider entry decides, else hug.'),
  background: field(text(CANVAS_LIMITS.backgroundCharsMax, { charsMin: 1 }), 'A CSS colour or var(--...) behind the component; absent: transparent.'),
});

export const COMPONENT_CANVAS_FILE_SCHEMA: FileSchema = {
  id: 'componentCanvas',
  file: '.stacki/component-canvas.json',
  description:
    'The component canvas, per component: which props get their own frames, and each frame\'s preview values, size and background. An entry keyed "" covers every frame, "variant=arrow" every arrow frame, and a full key one frame; a frame merges every entry whose pairs it has, the most specific last. Shared by Desktop and Studio.',
  requires: 'component:edit',
  metadataKind: 'componentCanvas',
  fields: {
    version: field(literal(1), 'The file format version.', { required: true }),
    background: field(
      text(CANVAS_LIMITS.backgroundCharsMax, { charsMin: 1 }),
      "The project canvas background: the surface every component canvas draws on, and what a frame shows where neither it nor its component sets one. A CSS colour, transparent, or var(--name); absent: the app's own canvas grey.",
    ),
    classes: field(
      rootClasses,
      "The project's canvas root classes: put on every component canvas's <html> after the classes the site's layout gives it, so a theme class (theme-dark) re-themes every frame. A component's root.classes replaces this list.",
    ),
    components: field(
      mapOf(
        objectOf({
          root: field(
            objectOf({
              background: field(rootBackground, "This component's canvas surface, over the project's background."),
              classes: field(rootClasses, "This component's canvas root classes, replacing the project's list."),
            }),
            "This component's canvas root (its page's <html>): each setting here replaces the project's.",
          ),
          arrange: field(
            text(6, { pattern: '^(?:row|column|wrap)$' }),
            'Older files: one layout for every level. Read as what each level shows; the app writes layouts in its place on the next layout edit.',
          ),
          layouts: field(
            mapOf(
              text(6, { pattern: '^(?:row|column|wrap)$' }),
              CANVAS_LIMITS.entriesMax,
              'a level: *canvas is the canvas (its html), else a group, as sorted name=value pairs joined by &',
              LEVEL_KEY,
            ),
            'How the direct children of each level are laid out: row (side by side), column (stacked) or wrap (rows that wrap at the Desktop width). Absent: a group is a row; the canvas is a column when it has groups, else a row. No level inherits another.',
          ),
          split: field(
            arrayOf(text(CANVAS_LIMITS.propNameCharsMax, { pattern: PROP_NAME }), CANVAS_LIMITS.splitPropsMax, { unique: true }),
            'The props whose values each get a frame, in layout order (the first is the rows); [] is one frame; absent: the variant prop.',
          ),
          frames: field(
            mapOf(frameEntry, CANVAS_LIMITS.entriesMax, 'a frame key: sorted name=value pairs joined by &, or "" for every frame', FRAME_KEY),
            'Frame settings by frame key.',
          ),
        }),
        CANVAS_LIMITS.componentsMax,
        'a project-relative component path (src/...)',
        COMPONENT_PATH,
      ),
      'Canvas settings by component file. Renaming, moving or deleting a component updates its key.',
      { required: true, commands: COMMANDS },
    ),
  },
  empty: { version: 1, components: {} },
  commands: [],
  parserSources: ['shared/properties/componentCanvas.ts'],
};
