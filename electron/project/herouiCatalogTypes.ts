import type { DefaultValue } from '../../shared/properties/componentDefaults';

export const HEROUI_CATEGORIES = [
  'Buttons',
  'Forms',
  'Date and time',
  'Navigation',
  'Overlays',
  'Collections',
  'Controls',
  'Feedback',
  'Layout',
  'Media',
  'Pickers',
  'Typography',
  'Data display',
  'Colors',
  'Utilities',
] as const;

type CatalogCategory = (typeof HEROUI_CATEGORIES)[number];

// The first string is the insertion default. The tuple also supplies the editor's choices.
export type CatalogProp = DefaultValue | readonly [string, ...string[]];

export interface HeroUICatalogEntry {
  readonly slug: string;
  readonly name: string;
  readonly category: CatalogCategory;
  readonly imports: readonly string[];
  readonly props: Readonly<Record<string, CatalogProp>>;
  readonly slots?: Readonly<Record<string, string>>;
  readonly hydrate?: true;
  readonly extraImports?: string;
  readonly setup?: string;
  readonly markup: string;
}

export const HEROUI_SIZES = ['md', 'sm', 'lg'] as const;
export const HEROUI_SURFACES = ['default', 'secondary', 'tertiary', 'transparent'] as const;
export const HEROUI_COLORS = ['accent', 'default', 'success', 'warning', 'danger'] as const;
