// The rest of the project the `@` picker finds besides files and skills: its pages, CSS variables,
// classes and assets (images, videos, fonts), from the data the Pages, Variables, Selectors and Assets
// panels already hold (their caches), handed over by the shell (src/app/shell/aiMentionIndex.ts), so the
// picker answers at once and never scans on its own. Here they become picker rows in groups, in a fixed
// order, each group ranked by match and capped, and one item appears in one group only: a file that is a
// component, layout, page or asset is not listed again under Files.
//
// Pure but for the small registry at the bottom; tested as plain functions (test/renderer/ai/projectMentions.test.js).
import { assert } from '../../../../shared/core/assert';
import { assetKindOf, isProjectRelativePath, type AssetKind, type MentionChip } from '../../../../shared/properties/ai/mentions';
import type { Translator } from '../../../lib/i18n/localeContext';
import { componentRows, memberRows, type MentionComponent } from './componentMentions';
import { baseName, type PickerRow } from './mentionChips';

/** Rows one group shows while searching, and rows the picker shows in all. */
export const GROUP_ROWS_MAX = 5;
export const MENTION_ROWS_MAX = 50;
/** Items of each kind the index holds: far more than a real project, so a bigger one is cut, not walked per key. */
export const MENTION_INDEX_ITEMS_MAX = 5_000;

export interface MentionPage {
  /** Project-relative. */
  readonly path: string;
  readonly route: string;
}

export interface MentionVariable {
  /** With its dashes: `--brand-1`. */
  readonly name: string;
  /** The project-relative file that defines it (a stylesheet, or the page whose style block does). */
  readonly path: string;
  /** The resolved colour, for a swatch, when the variable is one. */
  readonly color: string | undefined;
  /** The Variables panel group it is listed under (its heading), when it has one. */
  readonly group?: string | undefined;
}

export interface MentionClass {
  /** Without its dot. */
  readonly name: string;
  /** The first stylesheet that defines it, when the style check has run. */
  readonly path: string | undefined;
  readonly rules: number;
}

export interface MentionAsset {
  readonly path: string;
  readonly kind: AssetKind;
  /** The file on disk, for the thumbnail the Assets panel's small copy is made from. Never sent. */
  readonly abs: string;
  /** What the small copy is kept under (path, size, modified time). */
  readonly thumbnailKey: string;
}

export interface MentionIndex {
  readonly pages: readonly MentionPage[];
  readonly variables: readonly MentionVariable[];
  readonly classes: readonly MentionClass[];
  readonly assets: readonly MentionAsset[];
}

export const EMPTY_MENTION_INDEX: MentionIndex = { pages: [], variables: [], classes: [], assets: [] };

/** The index cut to its bounds and stripped of anything that is not a project-relative path: the shell's data checked once. */
export function boundedIndex(index: MentionIndex): MentionIndex {
  const pages = index.pages.filter((page) => isProjectRelativePath(page.path)).slice(0, MENTION_INDEX_ITEMS_MAX);
  const variables = index.variables.filter((variable) => isProjectRelativePath(variable.path)).slice(0, MENTION_INDEX_ITEMS_MAX);
  const classes = index.classes.filter((entry) => entry.path === undefined || isProjectRelativePath(entry.path)).slice(0, MENTION_INDEX_ITEMS_MAX);
  // An asset whose extension is not its kind's is a file, not an asset.
  const assets = index.assets.filter((asset) => isProjectRelativePath(asset.path) && assetKindOf(asset.path) === asset.kind).slice(0, MENTION_INDEX_ITEMS_MAX);
  return { pages, variables, classes, assets };
}

interface Ranked<Item> {
  readonly rank: number;
  readonly item: Item;
}

/** Items matching `query` by name first (prefix before anywhere), then by path; at most `limit`. An empty query takes all, in order. */
function ranked<Item>(
  items: readonly Item[],
  query: string,
  limit: number,
  keys: (item: Item) => { readonly name: string; readonly path: string },
): readonly Item[] {
  const needle = query.trim().toLocaleLowerCase();
  const found: Ranked<Item>[] = [];
  for (const item of items) {
    const { name, path } = keys(item);
    const lowerName = name.toLocaleLowerCase();
    const rank =
      needle === '' ? 0 : lowerName.startsWith(needle) ? 0 : lowerName.includes(needle) ? 1 : path.toLocaleLowerCase().includes(needle) ? 2 : undefined;
    if (rank !== undefined) {
      found.push({ rank, item });
    }
  }
  found.sort((left, right) => left.rank - right.rank);
  return found.slice(0, limit).map((entry) => entry.item);
}

/** A variable or class name without its sigil, so `@brand` finds `--brand-1` and `@hero` finds `.hero`. */
function bare(name: string): string {
  return name.replace(/^--/u, '');
}

/** The rows of each project group for `query`, in the picker's order, each ranked best first and capped at `limit`. */
export function projectGroupRows(
  index: MentionIndex,
  components: readonly MentionComponent[],
  query: string,
  translate: Translator,
  limit: number = GROUP_ROWS_MAX,
): readonly (readonly PickerRow[])[] {
  const pageGroup = translate('ai.mention.group.page');
  const pages = ranked(index.pages, query, limit, (page) => ({ name: baseName(page.path), path: `${page.path} ${page.route}` })).map((page): PickerRow => ({
    id: `page:${page.path}`,
    label: baseName(page.path),
    description: page.route,
    group: pageGroup,
    chip: { kind: 'file', path: page.path, name: baseName(page.path) },
    look: { kind: 'page' },
  }));
  const variableGroup = translate('ai.mention.group.variable');
  const variables = ranked(index.variables, query.replace(/^--/u, ''), limit, (variable) => ({ name: bare(variable.name), path: variable.path })).map(
    (variable): PickerRow => ({
      id: `variable:${variable.path}:${variable.name}`,
      label: variable.name,
      description: variable.path,
      group: variableGroup,
      chip: { kind: 'css', target: 'variable', name: variable.name, path: variable.path },
      look: { kind: 'variable', color: variable.color },
    }),
  );
  const classGroup = translate('ai.mention.group.class');
  const classes = ranked(index.classes, query.replace(/^\./u, ''), limit, (entry) => ({ name: entry.name, path: entry.path ?? '' })).map(
    (entry): PickerRow => ({
      id: `class:${entry.name}`,
      label: `.${entry.name}`,
      description: entry.path,
      group: classGroup,
      chip: { kind: 'css', target: 'class', name: entry.name, path: entry.path },
      look: { kind: 'class' },
    }),
  );
  const assetRows = (kind: AssetKind, group: string): readonly PickerRow[] =>
    ranked(
      index.assets.filter((asset) => asset.kind === kind),
      query,
      limit,
      (asset) => ({ name: baseName(asset.path), path: asset.path }),
    ).map((asset) => ({
      id: `asset:${asset.path}`,
      label: baseName(asset.path),
      description: asset.path,
      group,
      chip: { kind: 'asset', assetKind: asset.kind, path: asset.path },
      look: asset.kind === 'image' ? { kind: 'image', abs: asset.abs, key: asset.thumbnailKey } : { kind: asset.kind },
    }));
  return [
    componentRows(components, query, translate, limit),
    componentRows(components, query, translate, limit, { layouts: true }),
    pages,
    variables,
    classes,
    assetRows('image', translate('ai.mention.group.image')),
    assetRows('video', translate('ai.mention.group.video')),
    assetRows('font', translate('ai.mention.group.font')),
  ];
}

/** Every path the project groups stand for, so Files does not list one of them again. */
export function projectPaths(index: MentionIndex, components: readonly MentionComponent[]): ReadonlySet<string> {
  return new Set([...components.map((component) => component.path), ...index.pages.map((page) => page.path), ...index.assets.map((asset) => asset.path)]);
}

/** The picker's filter tabs: everything, or one kind of thing. Images, videos and fonts are Assets; skills and the built-in instructions are Other. */
export const MENTION_TABS = ['all', 'components', 'layouts', 'pages', 'variables', 'classes', 'assets', 'files', 'other'] as const;
export type MentionTab = (typeof MENTION_TABS)[number];

export interface MentionRowsAnswer {
  /** In the order drawn: the best group last, and in each group the best row last, so the best match is the bottom row. */
  readonly rows: readonly PickerRow[];
  /** Matches per tab (each kind's own cap applies; `all` is what the All tab draws). */
  readonly counts: Readonly<Record<MentionTab, number>>;
}

/**
 * How well a row matches, lower is better: 0 the label is the query, 1 it starts with it, 2 a word in it does
 * (after `-`, `_`, `/`, `.` or a space), 3 it holds it anywhere, 4 only its description (a path) does, 5 neither.
 * A sigil (`--`, `.`) is ignored on both sides, so `@brand` ranks `--brand` as exact.
 */
export function rowRank(row: PickerRow, query: string): number {
  const strip = (text: string): string => text.replace(/^(--|\.)/u, '').toLocaleLowerCase();
  const needle = strip(query.trim());
  if (needle === '') {
    return 0;
  }
  const label = strip(row.label);
  if (label === needle) {
    return 0;
  }
  if (label.startsWith(needle)) {
    return 1;
  }
  if (label.split(/[-_/. ]+/u).some((word) => word.startsWith(needle))) {
    return 2;
  }
  if (label.includes(needle)) {
    return 3;
  }
  return (row.description ?? '').toLocaleLowerCase().includes(needle) ? 4 : 5;
}

/**
 * All the picker's rows for one tab, the best first. The groups are: with a component in scope its members
 * (always first), then Components, Layouts, Pages, CSS variables, Classes, Images, Videos, Fonts, Files (less
 * what a group above already offers), Skills and Built-in. The All tab shows each group's best `GROUP_ROWS_MAX`,
 * a kind's own tab up to `MENTION_ROWS_MAX` of it. Groups go in order of their best row (a tie keeps that kind
 * order), and rows within a group best first. Groups with no match are absent; at most `MENTION_ROWS_MAX` rows.
 */
export function mentionRows(
  searched: readonly PickerRow[],
  options: {
    readonly components: readonly MentionComponent[] | undefined;
    readonly index: MentionIndex;
    readonly scope: string | undefined;
    readonly query: string;
    readonly tab: MentionTab;
    readonly translate: Translator;
  },
): MentionRowsAnswer {
  const components = options.components ?? [];
  const scoped = options.scope === undefined ? undefined : components.find((component) => component.path === options.scope);
  const members = scoped === undefined ? [] : memberRows(scoped, options.query, options.translate);
  const [componentGroup = [], layoutGroup = [], pages = [], variables = [], classes = [], images = [], videos = [], fonts = []] = projectGroupRows(
    options.index,
    components,
    options.query,
    options.translate,
    MENTION_ROWS_MAX,
  );
  const taken = projectPaths(options.index, components);
  const groups: readonly { readonly tab: Exclude<MentionTab, 'all'>; readonly rows: readonly PickerRow[] }[] = [
    { tab: 'components', rows: members },
    { tab: 'components', rows: componentGroup },
    { tab: 'layouts', rows: layoutGroup },
    { tab: 'pages', rows: pages },
    { tab: 'variables', rows: variables },
    { tab: 'classes', rows: classes },
    { tab: 'assets', rows: images },
    { tab: 'assets', rows: videos },
    { tab: 'assets', rows: fonts },
    { tab: 'files', rows: searched.filter((row) => row.chip.kind === 'file' && !taken.has(row.chip.path)) },
    { tab: 'other', rows: searched.filter((row) => row.chip.kind === 'skill') },
    { tab: 'other', rows: searched.filter((row) => row.chip.kind === 'builtin') },
  ];
  // Best first within each group (a stable sort keeps the source's own order among equals), then capped.
  const sorted = groups.map((group) => ({
    tab: group.tab,
    rows: [...group.rows].map((row) => ({ row, rank: rowRank(row, options.query) })).sort((left, right) => left.rank - right.rank),
  }));
  const shownIn = (tab: MentionTab, order: number, rows: readonly { readonly row: PickerRow; readonly rank: number }[]) =>
    rows.slice(0, tab === 'all' && order !== 0 ? GROUP_ROWS_MAX : MENTION_ROWS_MAX);
  const counts: Record<MentionTab, number> = { all: 0, components: 0, layouts: 0, pages: 0, variables: 0, classes: 0, assets: 0, files: 0, other: 0 };
  sorted.forEach((group, order) => {
    counts[group.tab] += group.rows.length;
    counts.all += shownIn('all', order, group.rows).length;
  });
  counts.all = Math.min(counts.all, MENTION_ROWS_MAX);
  const chosen = sorted
    .map((group, order) => ({ order, tab: group.tab, rows: shownIn(options.tab, order, group.rows) }))
    .filter((group) => group.rows.length > 0 && (options.tab === 'all' || group.tab === options.tab))
    .map((group) => ({ ...group, score: group.order === 0 ? -1 : Math.min(...group.rows.map((entry) => entry.rank)) }));
  // The best group first; on a tie the kind order decides (component, layout, page, variable, class, asset, file, built-in).
  chosen.sort((left, right) => left.score - right.score || left.order - right.order);
  const seen = new Set<string>();
  const rows: PickerRow[] = [];
  for (const group of chosen) {
    for (const { row } of group.rows) {
      if (rows.length < MENTION_ROWS_MAX && !seen.has(row.id)) {
        seen.add(row.id);
        rows.push(row);
      }
    }
  }
  assert(rows.length <= MENTION_ROWS_MAX, 'mentionRows: within the picker bound');
  return { rows, counts };
}

// ---------------------------------------------------------------------------
// Related classes and variables: what a CSS chip can be swapped for
// ---------------------------------------------------------------------------

/** Items a swap list holds: the family first, so a long tail of the project never pushes it out. */
export const RELATED_ITEMS_MAX = 200;

export interface RelatedItem {
  readonly chip: Extract<MentionChip, { readonly kind: 'css' }>;
  readonly label: string;
  readonly description: string | undefined;
  /** A colour variable's swatch. */
  readonly color: string | undefined;
  /** The chip's own class or variable: the row with the check. */
  readonly current: boolean;
}

/** A name's family: everything up to its last dash or underscore (`text-style-` for `text-style-h1`), else the name itself (`button`). */
export function familyOf(name: string): string {
  const bareName = name.replace(/^--/u, '');
  const cut = Math.max(bareName.lastIndexOf('-'), bareName.lastIndexOf('_'));
  return cut > 0 ? bareName.slice(0, cut + 1) : bareName;
}

/**
 * What a CSS chip can become, in order: its own family (names that start with the family, the chip's own
 * first), then the others its stylesheet defines (for a variable, its Variables panel group, then its file),
 * then the rest of the project; each once, at most `RELATED_ITEMS_MAX`. Hidden variables never reach the index.
 */
export function relatedItems(index: MentionIndex, chip: Extract<MentionChip, { readonly kind: 'css' }>): readonly RelatedItem[] {
  const family = familyOf(chip.name);
  const bareKey = (name: string): string => name.replace(/^--/u, '');
  const entries =
    chip.target === 'class'
      ? index.classes.map((entry) => ({
          chip: { kind: 'css' as const, target: 'class' as const, name: entry.name, path: entry.path },
          label: `.${entry.name}`,
          description: entry.path,
          color: undefined,
          tier: bareKey(entry.name).startsWith(family) ? 0 : entry.path !== undefined && entry.path === chip.path ? 1 : 2,
        }))
      : index.variables.map((entry) => {
          const own = index.variables.find((candidate) => candidate.name === chip.name && candidate.path === chip.path);
          const sameGroup = own?.group !== undefined && entry.group === own.group && entry.path === own.path;
          return {
            chip: { kind: 'css' as const, target: 'variable' as const, name: entry.name, path: entry.path },
            label: entry.name,
            description: entry.path,
            color: entry.color,
            tier: bareKey(entry.name).startsWith(family) ? 0 : sameGroup ? 1 : entry.path === chip.path ? 2 : 3,
          };
        });
  const isCurrent = (candidate: { readonly chip: RelatedItem['chip'] }): boolean => candidate.chip.name === chip.name && candidate.chip.path === chip.path;
  const ranked = entries
    .map((entry, order) => ({ ...entry, order, tier: isCurrent(entry) ? -1 : entry.tier }))
    .sort((left, right) => left.tier - right.tier || left.order - right.order);
  const seen = new Set<string>();
  const items: RelatedItem[] = [];
  for (const entry of ranked) {
    const key = `${entry.chip.name}\u0000${entry.chip.path ?? ''}`;
    if (!seen.has(key) && items.length < RELATED_ITEMS_MAX) {
      seen.add(key);
      items.push({ chip: entry.chip, label: entry.label, description: entry.description, color: entry.color, current: isCurrent(entry) });
    }
  }
  // The chip's own item leads the list even when the index no longer holds it, so the check always has a row.
  if (!items.some((item) => item.current)) {
    items.unshift({ chip, label: chip.target === 'class' ? `.${chip.name}` : chip.name, description: chip.path, color: undefined, current: true });
  }
  assert(items.filter((item) => item.current).length === 1, 'relatedItems: exactly one current item');
  return items.slice(0, RELATED_ITEMS_MAX);
}

// ---------------------------------------------------------------------------
// The index the shell provides
// ---------------------------------------------------------------------------

export interface MentionIndexSource {
  /** The index as the panels' caches hold it now; cheap, so it is read on every keystroke. */
  readonly read: () => MentionIndex;
  /** Asks the panels' sources again (a file changed since); the next read sees the answer. */
  readonly refresh: () => void;
}

let source: MentionIndexSource | undefined;

/** Called by the shell while a project is open; undefined when it closes. */
export function setMentionIndexSource(next: MentionIndexSource | undefined): void {
  source = next;
}

export function readMentionIndex(): MentionIndex {
  return source === undefined ? EMPTY_MENTION_INDEX : boundedIndex(source.read());
}

export function refreshMentionIndex(): void {
  source?.refresh();
}
