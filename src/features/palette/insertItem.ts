import type { ReactNode } from 'react';
import type { MessageKey } from '../../lib/i18n/localeContext';
import type { Translator } from '../../lib/i18n/localeContext';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import type { InsertFolderKey } from './insertFolders';

export interface InsertCardPlace {
  readonly folder: InsertFolderKey | undefined;
}

// What the insert palette lists and hands to `onInsert`. Kept apart from the component so the
// grid's cards can name the type without importing the palette that renders them.

export type InsertChoice =
  | { readonly type: 'component' | 'astroAsset'; readonly name: string; readonly path?: string }
  | { readonly type: 'element'; readonly tag: string }
  | {
      readonly type: 'map' | 'cond' | 'text' | 'comment' | 'expr' | 'doctype' | 'style' | 'script';
    };

export type InsertItem = InsertChoice & {
  readonly label: string;
  /** The label's message when the label is our own word (Loop, Text); absent when it is a tag or a project name. `label` stays English for search and ids. */
  readonly labelKey?: MessageKey;
  readonly sub?: string;
  /** Like `labelKey`, for a `sub` that is a sentence of ours. */
  readonly subKey?: MessageKey;
  readonly search?: string;
  readonly cat: 'components' | 'elements' | 'other';
  readonly icon: ReactNode;
  /**
   * Present on every item that is a card: components and `astro:assets` components. Its folder is the
   * pill it belongs to; Astro's own components are in no project folder.
   */
  readonly card?: InsertCardPlace;
  /** How often the project uses it; shown as `10×` when above zero. */
  readonly instances?: number;
  /** What the preview route needs to render it; absent when the component has no file to address. */
  readonly preview?: ScanComponent;
};

/** What a row or card draws as the item's name: ours in the active language, a tag or project name as it is. */
export function insertItemLabel(item: Pick<InsertItem, 'label' | 'labelKey'>, translate: Translator): string {
  return item.labelKey === undefined ? item.label : translate(item.labelKey);
}

/** What a row draws as the item's note, translated when it is a sentence of ours. */
export function insertItemSub(item: Pick<InsertItem, 'sub' | 'subKey'>, translate: Translator): string | undefined {
  return item.subKey === undefined ? item.sub : translate(item.subKey);
}
