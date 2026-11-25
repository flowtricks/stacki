import { assert } from '../core/assert';
import { DEFAULT_LIMITS } from './componentDefaults';
// Legacy starter recipes become editable project data on the first settings save.
import type { ComponentDefaults, ComponentRecipe, DefaultComponent } from './componentDefaults';

export const INSTANCE_HEADING = 'Lorem ipsum dolor sit amet elit';
export const INSTANCE_PARAGRAPH =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ' +
  'ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco ' +
  'laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in ' +
  'voluptate velit esse cillum dolore eu fugiat nulla pariatur.';

export function starterDefaults(catalog: readonly DefaultComponent[]): ComponentDefaults {
  assert(catalog.length <= DEFAULT_LIMITS.componentsMax, 'Starter catalog fits recipe storage');
  assert(new Set(catalog.map((item) => item.file)).size === catalog.length, 'Starter component paths are unique');
  // Ambiguous names are never guessed; project recipes use full relative paths.
  const unique = (name: string) => {
    const matches = catalog.filter((item) => item.name === name);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const text: Readonly<Record<string, string>> = {
    Heading: INSTANCE_HEADING,
    Paragraph: INSTANCE_PARAGRAPH,
    // i18n-ignore: a component name written into the project as source code, not interface text.
    Button: 'Button Text',
  };
  const children: Readonly<Record<string, readonly string[]>> = {
    ButtonWrapper: ['Button'],
    ContentWrapper: ['Heading', 'Paragraph', 'ButtonWrapper'],
    Grid: ['Card', 'Card', 'Card'],
    Slider: ['Card', 'Card'],
  };
  const props: Readonly<Record<string, ComponentRecipe['props']>> = {
    Grid: { small: 2, medium: 3 },
    Slider: { small: 1.4 },
    Card: { heading: INSTANCE_HEADING, text: INSTANCE_PARAGRAPH },
  };
  return {
    version: 1,
    components: Object.fromEntries(
      catalog.flatMap((component) => {
        const recipe: ComponentRecipe = {
          props: Object.fromEntries(Object.entries(props[component.name] ?? {}).filter(([name]) => component.props.includes(name))),
          ...(component.slots.includes('default') ? starterContent(component, text, children, unique) : {}),
        };
        return Object.keys(recipe.props ?? {}).length > 0 || recipe.text !== undefined || recipe.children !== undefined ? [[component.file, recipe]] : [];
      }),
    ),
  };
}

function starterContent(
  component: DefaultComponent,
  text: Readonly<Record<string, string>>,
  children: Readonly<Record<string, readonly string[]>>,
  unique: (name: string) => DefaultComponent | undefined,
): ComponentRecipe {
  const names = children[component.name];
  if (names) {
    return {
      children: names.flatMap((name) => {
        const child = unique(name);
        return child ? [{ component: child.file }] : [];
      }),
    };
  }
  const value = text[component.name] ?? (component.slotText ? 'Text' : undefined);
  return value === undefined ? {} : { text: value };
}
