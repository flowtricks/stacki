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
import { assetBindingName, defaultAttributes, isFragmentTag, withoutMissingAssets } from '../../../vendor/stacki/shared/properties/componentDefaultValues';
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
  /** Asset defaults whose file is gone: an insert goes without them. */
  readonly missingAssets?: readonly string[];
  readonly imports?: readonly ComponentImport[];
  readonly config: ComponentDefaults;
  readonly catalog: readonly DefaultComponent[];
}

/** The files an insert of `file` leaves out because they are gone. */
export function leftOutAssets(file: string | undefined, settings: InsertionDefaults | undefined): readonly string[] {
  if (file === undefined || settings === undefined || !settings.catalog.some((component) => component.file === file)) {
    return [];
  }
  const result = resolveComponentRecipe(file, settings.config, settings.catalog);
  const gone = new Set(settings.missingAssets);
  return result.ok ? withoutMissingAssets(result.value, (asset) => !gone.has(asset)).missing : [];
}

export function defaultInstance(
  file: string | undefined,
  settings: InsertionDefaults | undefined,
  resolve: (file: string, name: string) => string,
  // The name the page imports an asset default's file under; only a recipe holding files asks.
  assetImport: (asset: string) => string = (asset) => assetBindingName(asset, new Set()),
  builtinImport: (tag: string, from: string) => string = (tag) => tag,
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
      if (recipe.verbatim === undefined) {
        return { kind: 'text', value: recipe.literal };
      }
      return recipe.verbatim.startsWith('<!--') ? { kind: 'comment', value: recipe.verbatim.slice(4, -3) } : { kind: 'expr', value: recipe.verbatim };
    }
    let name: string;
    if ('component' in recipe) {
      const component = defaults.catalog.find((entry) => entry.file === recipe.component);
      assert(component !== undefined, 'Resolved recipe component exists');
      name = resolve(component.file, component.name);
    } else if (recipe.from !== undefined && recipe.tag !== undefined) {
      name = builtinImport(recipe.tag, recipe.from);
    } else if (isFragmentTag(recipe.tag)) {
      name = 'Fragment';
    } else {
      name = recipe.tag ?? recipe.element;
    }
    // A Fragment or a built-in is written as a component the project does not hold.
    const asComponent = 'component' in recipe || recipe.from !== undefined || isFragmentTag(recipe.tag);
    const shorthand = 'element' in recipe && recipe.tag === '<>' && Object.keys(recipe.props).length === 0;
    return {
      kind: asComponent ? 'component' : 'element',
      name,
      ...(shorthand ? { shorthand: true } : {}),
      props: Object.fromEntries(defaultAttributes(recipe, assetImport)),
      children:
        recipe.content.kind === 'empty'
          ? undefined
          : recipe.content.kind === 'text'
            ? [{ kind: 'text', value: recipe.content.text }]
            : recipe.content.children.map((child) => build(child, depth + 1)),
    };
  };
  const gone = new Set(defaults.missingAssets);
  return build(withoutMissingAssets(result.value, (asset) => !gone.has(asset)).node, 0);
}
