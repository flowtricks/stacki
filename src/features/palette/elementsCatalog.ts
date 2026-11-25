// What the Add elements panel offers (AddElementsPanel.tsx): every HTML tag the editor inserts, grouped the way a
// designer looks for them, and the Astro constructs the editor already knows how to write (the insert palette's
// own items, InsertSearch.tsx). Pure data and pure functions, so the catalog's completeness, the search and the
// grid's keyboard moves are tested without a DOM. Labels are message keys; a tag's own name is never translated.
import { assert } from '../../../shared/core/assert';
import { HTML_TAGS } from '../../editor/elementSchemas';
import { INSERT_DRAG_ASSETS, type InsertDragChoice } from '../../editor/insertDragData';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { tagSearchText } from '../../lib/insertRank';
import type { GridMove } from './insertGrid';

/** The two parts of the panel: plain HTML, and what only Astro has. */
export type ElementSectionId = 'html' | 'astro';

export const ELEMENT_GROUP_IDS = [
  'structure',
  'typography',
  'links',
  'lists',
  'media',
  'forms',
  'tables',
  'interactive',
  'inline',
  'document',
  'astroLogic',
  'astroComposition',
  'astroAssets',
  'astroBlocks',
] as const;
export type ElementGroupId = (typeof ELEMENT_GROUP_IDS)[number];

/** What choosing a tile does: insert a node, or (the Component tile) send the person to the Components panel. */
export type ElementTileAction = { readonly kind: 'insert'; readonly choice: InsertDragChoice } | { readonly kind: 'pickComponent' };

export interface ElementTile {
  /** Unique across the catalog: `tag:div`, `astro:loop`. */
  readonly id: string;
  /** The short name drawn on the tile. */
  readonly labelKey: MessageKey;
  /** The full name for the tooltip: the label's own key, or a longer one where the tile shows a shortened name. */
  readonly nameKey: MessageKey;
  readonly action: ElementTileAction;
  /** The code the tile writes, shown highlighted in its tooltip; absent when it writes none of its own (Text, Component). */
  readonly code: string | undefined;
  /** English words the search matches besides the label in the active language: the tag and what people call it. */
  readonly search: string;
}

export interface ElementGroup {
  readonly id: ElementGroupId;
  readonly section: ElementSectionId;
  readonly labelKey: MessageKey;
  readonly tiles: readonly ElementTile[];
}

/** The grid's width, as Webflow's Add panel draws it. */
export const ELEMENT_COLUMNS = 3;

// The catalog's size bounds: 112 tags and 13 Astro tiles today. A bound well past that, so a slip that repeats the
// list is caught, and so every search and grid move is bounded by a stated number.
export const ELEMENT_TILES_MAX = 256;
const SEARCH_CHARS_MAX = 200;

// The tags that have a friendly name; declared before the groups, which ask it while they are built.
const TAG_KEYS: ReadonlySet<string> = new Set([...HTML_TAGS, 'svg'].map((tag) => `elements.tag.${tag}`));

// The tags whose tile shows a short name (en/elements.ts says why); their full names are for the tooltip.
const TAG_FULL_NAME_KEYS: Readonly<Record<string, MessageKey>> = {
  abbr: 'elements.tagFull.abbr',
  bdo: 'elements.tagFull.bdo',
  blockquote: 'elements.tagFull.blockquote',
  colgroup: 'elements.tagFull.colgroup',
  del: 'elements.tagFull.del',
  dl: 'elements.tagFull.dl',
  figcaption: 'elements.tagFull.figcaption',
  hgroup: 'elements.tagFull.hgroup',
  ins: 'elements.tagFull.ins',
  kbd: 'elements.tagFull.kbd',
  link: 'elements.tagFull.link',
  ol: 'elements.tagFull.ol',
  optgroup: 'elements.tagFull.optgroup',
  pre: 'elements.tagFull.pre',
  rp: 'elements.tagFull.rp',
  s: 'elements.tagFull.s',
  samp: 'elements.tagFull.samp',
  small: 'elements.tagFull.small',
  source: 'elements.tagFull.source',
};

// Which group each tag belongs to. Every tag of HTML_TAGS is in exactly one (elementsCatalog.test.ts holds this), and
// `svg` joins them: the editor inserts inline SVG, though it is no HTML tag.
const TAG_GROUPS: Readonly<Record<Exclude<ElementGroupId, `astro${string}`>, readonly string[]>> = {
  structure: ['div', 'section', 'main', 'header', 'footer', 'nav', 'aside', 'article', 'search', 'hgroup'],
  typography: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'blockquote', 'q', 'pre', 'code', 'hr', 'br', 'wbr'],
  links: ['a', 'button'],
  lists: ['ul', 'ol', 'li', 'dl', 'dt', 'dd', 'menu'],
  media: ['img', 'picture', 'source', 'video', 'audio', 'track', 'svg', 'canvas', 'iframe', 'embed', 'object', 'figure', 'figcaption', 'map', 'area'],
  forms: ['form', 'input', 'textarea', 'select', 'option', 'optgroup', 'label', 'fieldset', 'legend', 'datalist', 'output', 'progress', 'meter'],
  tables: ['table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'],
  interactive: ['details', 'summary', 'dialog', 'template'],
  inline: [
    'strong',
    'em',
    'b',
    'i',
    'u',
    's',
    'small',
    'mark',
    'abbr',
    'cite',
    'dfn',
    'time',
    'data',
    'del',
    'ins',
    'kbd',
    'samp',
    'var',
    'sub',
    'sup',
    'bdi',
    'bdo',
    'ruby',
    'rt',
    'rp',
    'address',
  ],
  document: ['html', 'head', 'body', 'title', 'meta', 'link', 'base', 'style', 'script', 'noscript'],
};

const TAG_GROUP_ORDER = ['structure', 'typography', 'links', 'lists', 'media', 'forms', 'tables', 'interactive', 'inline', 'document'] as const;

function tagTile(tag: string): ElementTile {
  assert(tag.length > 0, 'elementsCatalog: a tag is never empty');
  const labelKey = tagLabelKey(tag);
  return {
    id: `tag:${tag}`,
    labelKey,
    nameKey: Object.hasOwn(TAG_FULL_NAME_KEYS, tag) ? (TAG_FULL_NAME_KEYS[tag] ?? labelKey) : labelKey,
    action: { kind: 'insert', choice: { type: 'element', tag } },
    code: `<${tag}>`,
    search: tagSearchText(tag),
  };
}

// The Astro tiles that show a short name, by tile name; their full names are for the tooltip. Declared before the
// groups, which ask it while they are built.
const ASTRO_FULL_NAME_KEYS: Readonly<Record<string, MessageKey>> = {
  image: 'elements.astroFull.image',
  picture: 'elements.astroFull.picture',
  scriptBlock: 'elements.astroFull.scriptBlock',
  styleBlock: 'elements.astroFull.styleBlock',
};

// The Astro tiles: each one is an item the insert palette already inserts (InsertSearch.tsx, OTHER_ITEMS and its
// Astro tags), so the panel adds no insertion of its own. `set:html` is a directive on an element, not a node, so it
// is set in the element's settings, not added here.
const ASTRO_GROUPS: readonly { readonly id: ElementGroupId; readonly tiles: readonly ElementTile[] }[] = [
  {
    id: 'astroLogic',
    tiles: [
      astroTile('loop', 'elements.astro.loop', { type: 'map' }, '{items.map((item) => ( … ))}', 'loop map repeat repeater each for list collection cms items'),
      astroTile('condition', 'elements.astro.condition', { type: 'cond' }, '{condition && ( … )}', 'condition if else ternary show hide conditional'),
      astroTile('expression', 'elements.astro.expression', { type: 'expr' }, '{ }', 'expression variable value output code braces'),
    ],
  },
  {
    id: 'astroComposition',
    tiles: [
      {
        id: 'astro:component',
        labelKey: 'elements.astro.component',
        nameKey: 'elements.astro.component',
        action: { kind: 'pickComponent' },
        code: undefined,
        search: 'component instance symbol reusable',
      },
      astroTile('fragment', 'elements.astro.fragment', { type: 'element', tag: 'Fragment' }, '<Fragment>', 'fragment group wrapper'),
      astroTile('slot', 'elements.astro.slot', { type: 'element', tag: 'slot' }, '<slot />', 'slot children caller'),
      astroTile('content', 'elements.astro.content', { type: 'element', tag: 'Content' }, '<Content />', 'content markdown entry render'),
    ],
  },
  {
    id: 'astroAssets',
    tiles: INSERT_DRAG_ASSETS.map((name) =>
      astroTile(
        name.toLowerCase(),
        name === 'Image' ? 'elements.astro.image' : 'elements.astro.picture',
        { type: 'astroAsset', name },
        `<${name} />`,
        `${name} astro assets image picture optimised responsive`,
      ),
    ),
  },
  {
    id: 'astroBlocks',
    tiles: [
      astroTile('text', 'elements.astro.text', { type: 'text' }, undefined, 'text plain words'),
      astroTile('comment', 'elements.astro.comment', { type: 'comment' }, '<!-- -->', 'comment note'),
      astroTile('styleBlock', 'elements.astro.styleBlock', { type: 'style' }, '<style>', 'style css block global'),
      astroTile('scriptBlock', 'elements.astro.scriptBlock', { type: 'script' }, '<script>', 'script javascript js block'),
    ],
  },
];

function astroTile(name: string, labelKey: MessageKey, choice: InsertDragChoice, code: string | undefined, search: string): ElementTile {
  assert(name.length > 0, 'elementsCatalog: an Astro tile has a name');
  assert(search.length <= SEARCH_CHARS_MAX, 'elementsCatalog: search words stay short');
  const nameKey = Object.hasOwn(ASTRO_FULL_NAME_KEYS, name) ? (ASTRO_FULL_NAME_KEYS[name] ?? labelKey) : labelKey;
  return { id: `astro:${name}`, labelKey, nameKey, action: { kind: 'insert', choice }, code, search };
}

/** Every group in the order the panel draws them: HTML first, then Astro. */
export const ELEMENT_GROUPS: readonly ElementGroup[] = [
  ...TAG_GROUP_ORDER.map((id): ElementGroup => ({
    id,
    section: 'html',
    labelKey: `elements.group.${id}`,
    // The doctype is no tag, but it heads a document, so it opens the Document group.
    tiles: [
      ...(id === 'document'
        ? [
            {
              id: 'tag:doctype',
              labelKey: 'elements.tag.doctype',
              nameKey: 'elements.tag.doctype',
              action: { kind: 'insert', choice: { type: 'doctype' } },
              code: '<!doctype html>',
              search: 'doctype html document',
            } as const satisfies ElementTile,
          ]
        : []),
      ...TAG_GROUPS[id].map(tagTile),
    ],
  })),
  ...ASTRO_GROUPS.map((group): ElementGroup => ({ id: group.id, section: 'astro', labelKey: `elements.group.${group.id}`, tiles: group.tiles })),
];

/** Every tag the HTML section offers, for the completeness test: HTML_TAGS and inline SVG. */
export const ELEMENT_HTML_TAGS: readonly string[] = [...HTML_TAGS, 'svg'];

/** The message key of a tag's friendly name. */
export function tagLabelKey(tag: string): MessageKey {
  // The catalog's keys are `elements.tag.<tag>` for every tag above; the parity of the two is elementsCatalog.test.ts's.
  const key = `elements.tag.${tag}`;
  assert(isElementTagKey(key), `elementsCatalog: ${tag} has a friendly name`);
  return key;
}

function isElementTagKey(key: string): key is MessageKey & `elements.tag.${string}` {
  return TAG_KEYS.has(key);
}

/** The groups the panel shows for `query`: a tile matches when every word is in its label or its search words. Groups left empty go. */
export function filterElementGroups(
  groups: readonly ElementGroup[],
  query: string,
  options: { readonly allowSlot: boolean },
  labelOf: (key: MessageKey) => string,
): readonly ElementGroup[] {
  const tokens = query.toLowerCase().slice(0, SEARCH_CHARS_MAX).split(/\s+/).filter(Boolean);
  const shown: ElementGroup[] = [];
  for (const group of groups) {
    assert(group.tiles.length <= ELEMENT_TILES_MAX, 'filterElementGroups: a group is bounded');
    const tiles = group.tiles.filter((tile) => tileOffered(tile, options) && tileMatches(tile, tokens, labelOf));
    if (tiles.length > 0) {
      shown.push(tiles.length === group.tiles.length ? group : { ...group, tiles });
    }
  }
  assert(shown.length <= groups.length, 'filterElementGroups: filtering never adds a group');
  return shown;
}

// A slot means "what the caller passes in", which only a component has: on a page it is not offered, as in the palette.
function tileOffered(tile: ElementTile, options: { readonly allowSlot: boolean }): boolean {
  if (tile.id === 'astro:slot') {
    return options.allowSlot;
  }
  return true;
}

function tileMatches(tile: ElementTile, tokens: readonly string[], labelOf: (key: MessageKey) => string): boolean {
  if (tokens.length === 0) {
    return true;
  }
  // The full name too, so "strikethrough" still finds the tile drawn as "Strike".
  const fullName = tile.nameKey === tile.labelKey ? '' : labelOf(tile.nameKey);
  const haystack = `${labelOf(tile.labelKey)} ${fullName} ${tile.search} ${tile.code ?? ''}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/** What the panel's fold-all button does next: fold every group while any is open, open them all once none is. */
export function foldAllAction(collapsed: ReadonlySet<ElementGroupId>): 'collapse' | 'expand' {
  assert(collapsed.size <= ELEMENT_GROUP_IDS.length, 'foldAllAction: only catalog groups fold');
  const allFolded = ELEMENT_GROUP_IDS.every((id) => collapsed.has(id));
  if (allFolded) {
    return 'expand';
  }
  return 'collapse';
}

/**
 * Where an arrow key moves the focus in the grid of open groups. `sizes` is the tile count of each group drawn, in
 * order; `current` is a position in all of them, counted through. Left and right step through the tiles in reading
 * order; up and down keep the column, moving between groups' rows as if they were one grid, and stop at the ends.
 */
export function moveElementFocus(sizes: readonly number[], current: number, move: GridMove): number {
  const rows = gridRows(sizes);
  const count = sizes.reduce((sum, size) => sum + size, 0);
  assert(count > 0, 'moveElementFocus: the grid has a tile');
  assert(current >= 0, 'moveElementFocus: the focus is a position');
  assert(current < count, 'moveElementFocus: the focus sits on a tile');
  switch (move) {
    case 'left':
      return Math.max(current - 1, 0);
    case 'right':
      return Math.min(current + 1, count - 1);
    case 'up':
    case 'down': {
      const rowIndex = rows.findIndex((row) => current >= row.start && current < row.start + row.length);
      assert(rowIndex >= 0, 'moveElementFocus: every tile is in a row');
      const row = rows[rowIndex];
      const target = rows[move === 'up' ? rowIndex - 1 : rowIndex + 1];
      if (row === undefined || target === undefined) {
        return current;
      }
      const column = current - row.start;
      return target.start + Math.min(column, target.length - 1);
    }
    default: {
      const exhaustive: never = move;
      return exhaustive;
    }
  }
}

function gridRows(sizes: readonly number[]): readonly { readonly start: number; readonly length: number }[] {
  const rows: { readonly start: number; readonly length: number }[] = [];
  let start = 0;
  for (const size of sizes) {
    assert(size >= 0, 'gridRows: a group size is a count');
    assert(size <= ELEMENT_TILES_MAX, 'gridRows: a group is bounded');
    for (let offset = 0; offset < size; offset += ELEMENT_COLUMNS) {
      rows.push({ start: start + offset, length: Math.min(ELEMENT_COLUMNS, size - offset) });
    }
    start += size;
  }
  return rows;
}
