// The project index the AI composer's `@` picker searches beyond files and skills
// (src/features/ai/mentions/projectMentions.ts), read from what the panels already hold, never
// scanned again: pages from the project scan, CSS variables from the Variables panel's cache (its
// private `--_` variables already left out by that panel's reader), classes from the Selectors panel's
// last check (else the class names the Style panel offers, with no file), and images, videos and fonts
// from the Assets panel's listing. Each read builds the index only when a cache changed (memoised on the
// cached values), so a keystroke costs a lookup. `refresh` asks the Variables and Assets sources again
// (their panels do the same on a file change), so the next read is current.
import { assert } from '../../../shared/core/assert';
import { assetKindOf } from '../../../shared/properties/ai/mentions';
import type { ScanPage } from '../../../shared/properties/projectScan';
import type { SelectorReport } from '../../../shared/properties/selectorUsage';
import type { AssetListing } from '../../features/assets/assetListingCache';
import { assetCache, prewarmAssetListing } from '../../features/assets/assetListingCache';
import { thumbnailKey } from '../../features/assets/AssetItemParts';
import { MENTION_INDEX_ITEMS_MAX, type MentionClass, type MentionIndex, type MentionIndexSource } from '../../features/ai/mentions/projectMentions';
import { selectorReportCache } from '../../features/selectors/selectorsBridge';
import { prewarmVariables, variableCache } from '../../features/variables/variableCache';
import type { VariablesSnapshot } from '../../ipc/variablesBridge';
import { projectRelativePath } from '../../lib/projectPath';
import type { PanelCache } from '../../lib/usePanelData';

/** Every class name a selector names (`.card:hover .title` gives card and title). */
const CLASS_IN_SELECTOR = /\.(-?[_\p{L}][\p{L}\p{N}_-]*)/gu;

export interface IndexInputs {
  readonly projectPath: string;
  readonly platform: NodeJS.Platform;
  readonly pages: readonly ScanPage[];
  readonly variables: VariablesSnapshot | undefined;
  readonly selectors: SelectorReport | undefined;
  readonly classNames: readonly string[];
  readonly assets: AssetListing | undefined;
}

/** The index from the panels' data; pure, so it is tested without the panels. */
export function mentionIndexOf(inputs: IndexInputs): MentionIndex {
  const relative = (file: string): string => projectRelativePath(inputs.projectPath, file, inputs.platform);
  const pages = inputs.pages.slice(0, MENTION_INDEX_ITEMS_MAX).map((page) => ({ path: relative(page.path), route: page.route }));
  const variables: { name: string; path: string; color: string | undefined; group: string | undefined }[] = [];
  const seenVariables = new Set<string>();
  for (const file of inputs.variables?.files ?? []) {
    for (const group of file.groups) {
      for (const block of group.blocks) {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            const key = cell === undefined ? '' : `${file.rel}\u0000${cell.name}`;
            if (cell !== undefined && !seenVariables.has(key) && variables.length < MENTION_INDEX_ITEMS_MAX) {
              seenVariables.add(key);
              variables.push({ name: cell.name, path: file.rel, color: cell.color, group: block.title ?? (group.label === '' ? undefined : group.label) });
            }
          }
        }
      }
    }
  }
  const classes = classesOf(inputs.selectors, inputs.classNames);
  const assets = (inputs.assets?.entries ?? []).flatMap((entry) => {
    if (entry.isDir) {
      return [];
    }
    const path = relative(entry.abs);
    const kind = assetKindOf(path);
    return kind === undefined ? [] : [{ path, kind, abs: entry.abs, thumbnailKey: thumbnailKey(entry) }];
  });
  assert(variables.length <= MENTION_INDEX_ITEMS_MAX, 'mentionIndexOf: variables are bounded');
  return { pages, variables, classes, assets: assets.slice(0, MENTION_INDEX_ITEMS_MAX) };
}

/** Classes by name, once each: the first stylesheet that defines one, and how many rules name it. */
function classesOf(report: SelectorReport | undefined, names: readonly string[]): readonly MentionClass[] {
  const found = new Map<string, { path: string | undefined; rules: number }>();
  for (const entry of report?.entries ?? []) {
    for (const match of entry.selector.matchAll(CLASS_IN_SELECTOR)) {
      const name = match[1];
      if (name !== undefined && (found.has(name) || found.size < MENTION_INDEX_ITEMS_MAX)) {
        const known = found.get(name);
        found.set(name, { path: known?.path ?? entry.rel, rules: (known?.rules ?? 0) + 1 });
      }
    }
  }
  // Class names used in the markup that no checked stylesheet defines (a utility framework's) still count.
  for (const name of names) {
    if (!found.has(name) && found.size < MENTION_INDEX_ITEMS_MAX) {
      found.set(name, { path: undefined, rules: 0 });
    }
  }
  return [...found].map(([name, value]) => ({ name, path: value.path, rules: value.rules }));
}

/** The source the composer reads: the caches now, memoised on the values they hold. */
export function mentionIndexSource(options: {
  readonly projectPath: string;
  readonly platform: NodeJS.Platform;
  readonly pages: readonly ScanPage[];
  readonly classNames: readonly string[];
}): MentionIndexSource {
  let last: { readonly inputs: readonly unknown[]; readonly index: MentionIndex } | undefined;
  const cached = <T>(cache: PanelCache<T>): T | undefined => {
    const data = cache.get(options.projectPath);
    return data?.kind === 'ready' ? data.value : undefined;
  };
  return {
    read: () => {
      const variablesValue = cached(variableCache);
      const selectors = cached(selectorReportCache);
      const assets = cached(assetCache);
      const inputs = [options.pages, variablesValue, selectors, options.classNames, assets];
      if (last !== undefined && last.inputs.every((input, index) => input === inputs[index])) {
        return last.index;
      }
      const index = mentionIndexOf({ ...options, variables: variablesValue, selectors, assets });
      last = { inputs, index };
      return index;
    },
    refresh: () => {
      void prewarmVariables(options.projectPath).catch(() => undefined);
      void prewarmAssetListing(options.projectPath).catch(() => undefined);
    },
  };
}
