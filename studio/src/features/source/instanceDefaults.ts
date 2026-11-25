import type { ParserNode } from './source';
import type { ComponentImport } from './imports';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import {
  resolveComponentRecipe,
  DEFAULT_LIMITS,
  type ComponentDefaults,
  type DefaultComponent,
  type ResolvedNode,
} from '../../../vendor/stacki/shared/properties/componentDefaults';
import { starterDefaults, INSTANCE_HEADING, INSTANCE_PARAGRAPH } from '../../../vendor/stacki/shared/properties/componentStarterDefaults';
export const HEADING_TEXT = INSTANCE_HEADING;
export const PARAGRAPH_TEXT = INSTANCE_PARAGRAPH;

// Kept only for callers without project context, such as source transformation tests.
const starterFiles = [
  'typography/Heading',
  'typography/Paragraph',
  'Button',
  'wrapper/ButtonWrapper',
  'wrapper/ContentWrapper',
  'wrapper/Grid',
  'interactive/Slider',
  'item/Card',
];
const starterCatalog: readonly DefaultComponent[] = starterFiles.map((file) => ({
  file: `src/components/${file}.astro`,
  name: file.split('/').at(-1) ?? '',
  props: ['heading', 'text', 'small', 'medium'],
  slots: ['default'],
  slotText: false,
}));
export interface InsertionDefaults {
  readonly imports?: readonly ComponentImport[];
  readonly config: ComponentDefaults;
  readonly catalog: readonly DefaultComponent[];
}

export function defaultInstance(
  file: string | undefined,
  settings: InsertionDefaults | undefined,
  resolve: (file: string, name: string) => string,
): ParserNode | undefined {
  const defaults = settings ?? {
    config: starterDefaults(starterCatalog),
    catalog: starterCatalog,
  };
  if (!file || !defaults.catalog.some((component) => component.file === file)) {
    return undefined;
  }
  const result = resolveComponentRecipe(file, defaults.config, defaults.catalog);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  const build = (recipe: ResolvedNode, depth: number): ParserNode => {
    assert(depth <= DEFAULT_LIMITS.depthMax, 'Default instance depth is bounded');
    if ('literal' in recipe) {
      return { kind: 'text', value: recipe.literal };
    }
    let name: string;
    if ('component' in recipe) {
      const component = defaults.catalog.find((entry) => entry.file === recipe.component);
      assert(component !== undefined, 'Resolved recipe component exists');
      name = resolve(component.file, component.name);
    } else {
      name = recipe.element;
    }
    return {
      kind: 'component' in recipe ? 'component' : 'element',
      name,
      props: Object.fromEntries(
        Object.entries(recipe.props).map(([name, value]) => [
          name,
          {
            type: typeof value === 'string' ? 'string' : 'expr',
            value: String(value),
          },
        ]),
      ),
      children:
        recipe.content.kind === 'empty'
          ? undefined
          : recipe.content.kind === 'text'
            ? [{ kind: 'text', value: recipe.content.text }]
            : recipe.content.children.map((child) => build(child, depth + 1)),
    };
  };
  return build(result.value, 0);
}
