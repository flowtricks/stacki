// The bar pinned under the Assets panel's files: the sort on the left ("Newest first ⌄") and the view
// on the right (an icon button showing the current view). Both open the shared Menu, whose check
// ends the chosen row, and a choice applies in the same frame it is made: it is a state change, with
// nothing to load. Remembering the choice per project is the caller's (assetViewPreferences.ts).
import type { ReactNode } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import Menu, { useMenuTrigger, type MenuEntry } from '../../ui/Menu';
import { ChevronDownIcon, CompactListViewIcon, GridViewIcon, ListViewIcon } from '../../ui/Icons';
import { ASSET_SORTS, ASSET_VIEWS, type AssetSort, type AssetView } from './assetOrder';
import type { AssetViewChoice } from './assetViewPreferences';

export function AssetFooter({ choice, onChange }: { readonly choice: AssetViewChoice; readonly onChange: (next: AssetViewChoice) => void }) {
  const translate = useTranslate();
  const sortMenu = useMenuTrigger();
  const viewMenu = useMenuTrigger();
  const sortLabel = sortText(choice.sort, translate);
  const viewLabel = viewText(choice.view, translate);
  return (
    <div className="asset-footer">
      <button
        ref={sortMenu.ref}
        type="button"
        className="ghost asset-footer-sort"
        aria-label={translate('assets.sort.label', { sort: sortLabel })}
        title={translate('assets.sort.menu')}
        aria-haspopup="menu"
        aria-expanded={sortMenu.open}
        onClick={sortMenu.toggle}
      >
        <span className="asset-footer-sort-label">{sortLabel}</span>
        <ChevronDownIcon size={11} />
      </button>
      <button
        ref={viewMenu.ref}
        type="button"
        className="ghost asset-footer-view"
        aria-label={translate('assets.view.label', { view: viewLabel })}
        title={translate('assets.view.label', { view: viewLabel })}
        aria-haspopup="menu"
        aria-expanded={viewMenu.open}
        onClick={viewMenu.toggle}
      >
        {viewIcon(choice.view)}
      </button>
      <Menu
        open={sortMenu.open}
        anchor={sortMenu.anchor}
        label={translate('assets.sort.menu')}
        placement="above-start"
        entries={sortMenu.open ? sortEntries(choice, translate, onChange) : []}
        onClose={sortMenu.close}
      />
      <Menu
        open={viewMenu.open}
        anchor={viewMenu.anchor}
        label={translate('assets.view.menu')}
        placement="above-end"
        entries={viewMenu.open ? viewEntries(choice, translate, onChange) : []}
        onClose={viewMenu.close}
      />
    </div>
  );
}

export function sortEntries(choice: AssetViewChoice, translate: Translator, onChange: (next: AssetViewChoice) => void): readonly MenuEntry[] {
  return ASSET_SORTS.map((sort): MenuEntry => ({
    kind: 'item',
    id: `sort-${sort}`,
    label: sortText(sort, translate),
    checked: sort === choice.sort,
    onSelect: () => onChange({ ...choice, sort }),
  }));
}

export function viewEntries(choice: AssetViewChoice, translate: Translator, onChange: (next: AssetViewChoice) => void): readonly MenuEntry[] {
  return ASSET_VIEWS.map((view): MenuEntry => ({
    kind: 'item',
    id: `view-${view}`,
    label: viewText(view, translate),
    icon: viewIcon(view),
    checked: view === choice.view,
    onSelect: () => onChange({ ...choice, view }),
  }));
}

function sortText(sort: AssetSort, translate: Translator): string {
  switch (sort) {
    case 'newest':
      return translate('assets.sort.newest');
    case 'oldest':
      return translate('assets.sort.oldest');
    case 'nameAscending':
      return translate('assets.sort.nameAscending');
    case 'nameDescending':
      return translate('assets.sort.nameDescending');
    case 'largest':
      return translate('assets.sort.largest');
    case 'smallest':
      return translate('assets.sort.smallest');
    default: {
      const exhaustive: never = sort;
      return exhaustive;
    }
  }
}

function viewText(view: AssetView, translate: Translator): string {
  switch (view) {
    case 'grid':
      return translate('assets.view.grid');
    case 'list':
      return translate('assets.view.list');
    case 'compact':
      return translate('assets.view.compact');
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}

function viewIcon(view: AssetView): ReactNode {
  switch (view) {
    case 'grid':
      return <GridViewIcon size={14} />;
    case 'list':
      return <ListViewIcon size={14} />;
    case 'compact':
      return <CompactListViewIcon size={14} />;
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
}
