// Canonical property ordering + section grouping for the style panel.
//
// The panel shows declarations in a fixed Webflow-like order grouped into
// sections, regardless of the order they appear in the embed source. This is a
// pure, render-only transform: it never mutates the AST, so an author's embed
// is only ever touched by an explicit edit (see the css.ts "no reflow" promise).

import type { ParsedDeclaration } from './styleTypes';

export type SectionId =
  | 'flex-child'
  | 'layout'
  | 'size'
  | 'spacing'
  | 'position'
  | 'typography'
  | 'backgrounds'
  | 'borders'
  | 'effects'
  | 'other';

export type SectionDefinition = {
  id: SectionId;
  label: string;
  /** Canonical property order within the section (lowercased, matches decl.prop). */
  order: readonly string[];
};

// The taxonomy + canonical order. `other` has no fixed order — it keeps source
// order (see groupDeclarations) and catches anything unclassified.
export const SECTIONS: readonly SectionDefinition[] = [
  {
    // Properties that apply when the element is a child of a flex/grid container.
    // Sits above Layout so a selected flex item's sizing/alignment reads top-down.
    id: 'flex-child',
    label: 'Flex/Grid Child',
    order: [
      'flex',
      'flex-grow',
      'flex-shrink',
      'flex-basis',
      // The Position control reads column/row shorthands and line longhands.
      // grid-area has no dedicated field; NO_CONTROL sends it to Other properties.
      'grid-area',
      'grid-column',
      'grid-column-start',
      'grid-column-end',
      'grid-row',
      'grid-row-start',
      'grid-row-end',
      'align-self',
      'justify-self',
      'order',
    ],
  },
  {
    id: 'layout',
    label: 'Layout',
    order: [
      'display',
      'vertical-align',
      'flex-direction',
      'flex-wrap',
      'flex-flow',
      'justify-content',
      'align-items',
      'align-content',
      'place-content',
      // Gap + its legacy `grid-*-gap` aliases — all owned by the Gap control, so they
      // stay out of Other properties.
      'gap',
      'row-gap',
      'column-gap',
      'grid-gap',
      'grid-row-gap',
      'grid-column-gap',
      'grid-template-columns',
      'grid-template-rows',
      'grid-template-areas',
      'grid-auto-flow',
      'grid-auto-columns',
      'grid-auto-rows',
      'justify-items',
      'place-self',
    ],
  },
  {
    id: 'spacing',
    label: 'Spacing',
    // The sides only: the box has a field for each longhand. The resolved model
    // projects `margin` and the padding shorthands onto these sides
    // (spacingShorthand.ts), so the box shows them. The shorthand itself is left
    // out, as a property listed in a section is routed to that section's control
    // and the box has none for it: it falls through to the catch-all at the
    // bottom, where it can still be edited and cleared whole, as written.
    order: [
      'margin-top',
      'margin-right',
      'margin-bottom',
      'margin-left',
      'padding-top',
      'padding-right',
      'padding-bottom',
      'padding-left',
    ],
  },
  {
    id: 'size',
    label: 'Size',
    order: [
      'width',
      'height',
      'min-width',
      'max-width',
      'min-height',
      'max-height',
      'overflow',
      'overflow-x',
      'overflow-y',
      'aspect-ratio',
      'box-sizing',
      // Handled by the Size section's Image fit control (SizeSection reads them
      // directly) — listed here so they don't fall through to Other properties.
      'object-fit',
      'object-position',
    ],
  },
  {
    id: 'position',
    label: 'Position',
    order: ['position', 'inset', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear'],
  },
  {
    id: 'typography',
    label: 'Typography',
    order: [
      'color',
      'font-family',
      'font-weight',
      'font-size',
      'line-height',
      'text-align',
      'text-decoration',
      'text-decoration-line',
      'text-decoration-style',
      'text-decoration-color',
      'text-decoration-thickness',
      'text-decoration-skip-ink',
      'text-transform',
      'font-style',
      'letter-spacing',
      'text-indent',
      'columns',
      'column-count',
      'column-gap',
      'column-rule',
      'column-rule-style',
      'column-rule-width',
      'column-rule-color',
      'column-span',
      'white-space',
      'word-break',
      'overflow-wrap',
      'text-overflow',
      'text-wrap',
      '-webkit-text-stroke',
      '-webkit-text-stroke-width',
      '-webkit-text-stroke-color',
      'text-shadow',
      'direction',
    ],
  },
  {
    id: 'backgrounds',
    label: 'Backgrounds',
    order: [
      'background',
      'background-color',
      'background-image',
      'background-position',
      'background-size',
      'background-repeat',
      'background-attachment',
      'background-clip',
      'background-origin',
    ],
  },
  {
    id: 'borders',
    label: 'Borders',
    order: [
      'border-radius',
      'border-top-left-radius',
      'border-top-right-radius',
      'border-bottom-right-radius',
      'border-bottom-left-radius',
      'border',
      'border-width',
      'border-style',
      'border-color',
      'border-top',
      'border-right',
      'border-bottom',
      'border-left',
      'border-top-width',
      'border-top-style',
      'border-top-color',
      'border-right-width',
      'border-right-style',
      'border-right-color',
      'border-bottom-width',
      'border-bottom-style',
      'border-bottom-color',
      'border-left-width',
      'border-left-style',
      'border-left-color',
    ],
  },
  {
    id: 'effects',
    label: 'Effects',
    order: [
      'mix-blend-mode',
      'opacity',
      'outline',
      'outline-style',
      'outline-width',
      'outline-color',
      'outline-offset',
      'box-shadow',
      'transform',
      'transform-origin',
      'transform-style',
      'perspective',
      'perspective-origin',
      'backface-visibility',
      'transition',
      'transition-property',
      'transition-duration',
      'transition-timing-function',
      'transition-delay',
      'filter',
      'backdrop-filter',
      'clip-path',
      '-webkit-clip-path',
      'cursor',
      'pointer-events',
    ],
  },
  { id: 'other', label: 'Other properties', order: [] },
];

// Property → section, and property → its canonical index within that section. Built once
// from SECTIONS so the taxonomy is the single source of truth.
export const PROPERTY_SECTION: ReadonlyMap<string, SectionId> = (() => {
  const map = new Map<string, SectionId>();
  for (const section of SECTIONS) {
    for (const prop of section.order) {
      map.set(prop, section.id);
    }
  }
  return map;
})();

export const PROPERTY_ORDER: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (const section of SECTIONS) {
    section.order.forEach((prop, index) => map.set(prop, index));
  }
  return map;
})();

// Properties a section names for ORDERING but has no control for. A section's
// order is where a property sorts when it's rendered; it is not a claim that it
// is. `inset: 0` sorted next to top/right/bottom/left and was then rendered by
// nothing — the inset box asks for each side separately — so it was in the file
// and nowhere in the panel: not in Position, not in Other properties, not
// anywhere. A property with no control belongs in Other properties, where it
// can at least be read and edited as text.
//
// Every one of these is a shorthand whose longhands DO have controls. Adding a
// control for one is what takes it off this list.
const NO_CONTROL: ReadonlySet<string> = new Set([
  'inset',
  'grid-area',
  'outline',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'columns',
  'column-rule',
]);

/** The section a property belongs to, or 'other' when unclassified. */
export function sectionOf(prop: string): SectionId {
  if (NO_CONTROL.has(prop)) {
    return 'other';
  }
  return PROPERTY_SECTION.get(prop) ?? 'other';
}

export type SectionGroup = {
  def: SectionDefinition;
  /** Present declarations for this section, canonically ordered. */
  decls: ParsedDeclaration[];
};

// A large sentinel so unknown props inside a known section sort to the bottom
// (keeping their relative source order via a stable sort).
const UNRANKED = Number.MAX_SAFE_INTEGER;

/**
 * Bucket declarations into sections and order them canonically for rendering.
 * Known sections are sorted by PROPERTY_ORDER (stable — unknown props sink to the
 * bottom keeping source order); `other` preserves source order entirely. Sections
 * are emitted in SECTIONS order, with `other` last. Empty sections are omitted
 * unless listed in `alwaysShow` (e.g. Size, whose controls always render).
 */
export function groupDeclarations(
  decls: ParsedDeclaration[],
  alwaysShow: readonly SectionId[] = [],
): SectionGroup[] {
  const buckets = new Map<SectionId, ParsedDeclaration[]>();
  decls.forEach((decl) => {
    const id = sectionOf(decl.prop);
    const list = buckets.get(id);
    if (list) {
      list.push(decl);
    } else {
      buckets.set(id, [decl]);
    }
  });

  const groups: SectionGroup[] = [];
  for (const definition of SECTIONS) {
    const list = buckets.get(definition.id) ?? [];
    const has = list.length > 0;
    if (!has && !alwaysShow.includes(definition.id)) {
      continue;
    }
    if (has && definition.id !== 'other') {
      // Stable sort by canonical index; equal ranks keep their source order.
      list
        .map((decl, index) => ({ decl, index, rank: PROPERTY_ORDER.get(decl.prop) ?? UNRANKED }))
        .sort((left, right) => left.rank - right.rank || left.index - right.index)
        .forEach((entry, i) => {
          list[i] = entry.decl;
        });
    }
    groups.push({ def: definition, decls: list });
  }
  return groups;
}

export type SectionPropGroup = { def: SectionDefinition; props: string[] };

/** Like groupDeclarations but over bare property names (for the resolved model). */
export function groupProps(
  propNames: string[],
  alwaysShow: readonly SectionId[] = [],
): SectionPropGroup[] {
  const buckets = new Map<SectionId, string[]>();
  propNames.forEach((prop) => {
    const id = sectionOf(prop);
    const list = buckets.get(id);
    if (list) {
      list.push(prop);
    } else {
      buckets.set(id, [prop]);
    }
  });

  const groups: SectionPropGroup[] = [];
  for (const definition of SECTIONS) {
    const list = buckets.get(definition.id) ?? [];
    const has = list.length > 0;
    if (!has && !alwaysShow.includes(definition.id)) {
      continue;
    }
    if (has && definition.id !== 'other') {
      list
        .map((prop, index) => ({ prop, index, rank: PROPERTY_ORDER.get(prop) ?? UNRANKED }))
        .sort((left, right) => left.rank - right.rank || left.index - right.index)
        .forEach((entry, i) => {
          list[i] = entry.prop;
        });
    }
    groups.push({ def: definition, props: list });
  }
  return groups;
}
