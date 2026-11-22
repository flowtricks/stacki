// The card each Style selectors tab shows when it lists nothing, built on the shared EmptyState. Kept out
// of the panel so the choice (which title, which sentence, whether to offer All) is a small function over
// the report, the tab and the search text, and can be rendered and tested on its own.
import type { ReactElement } from 'react';
import type { Translator } from '../../lib/i18n/localeContext';
import type { SelectorReport } from '../../../shared/properties/selectorUsage';
import { EmptyState } from '../../ui/EmptyState';
import { CheckIcon, SearchIcon } from '../../ui/Icons';
import { LockIcon, StyleSelectorsIcon } from './SelectorIcons';
import type { SelectorFilter } from './selectorList';

// The card a tab shows when it lists nothing. A search that finds nothing is "No matches" on any tab; an
// otherwise empty tab says why, and offers All where All has something to show.
export function selectorEmptyState(report: SelectorReport, filter: SelectorFilter, search: string, translate: Translator, onShowAll: () => void): ReactElement {
  if (report.entries.length === 0) {
    return (
      <EmptyState
        icon={<StyleSelectorsIcon size={20} />}
        title={translate('selectors.empty.allTitle')}
        description={translate('selectors.empty.noSelectors')}
      />
    );
  }
  if (search.trim() !== '') {
    return <EmptyState icon={<SearchIcon size={20} />} title={translate('selectors.empty.searchTitle')} description={translate('selectors.empty.noMatch')} />;
  }
  const showAll = (
    <button className="selectors-cancel" onClick={onShowAll}>
      {translate('selectors.empty.showAll')}
    </button>
  );
  switch (filter) {
    case 'unused':
      return (
        <EmptyState
          icon={<CheckIcon size={20} />}
          title={translate('selectors.empty.unusedTitle')}
          description={translate('selectors.empty.noUnused')}
          action={showAll}
        />
      );
    case 'kept':
      return (
        <EmptyState
          icon={<LockIcon open={false} size={20} />}
          title={translate('selectors.empty.lockedTitle')}
          description={translate('selectors.empty.noLocked')}
          action={showAll}
        />
      );
    case 'unknown':
      return (
        <EmptyState
          icon={<CheckIcon size={20} />}
          title={translate('selectors.empty.certainTitle')}
          description={translate('selectors.empty.certain')}
          action={showAll}
        />
      );
    case 'all':
      return (
        <EmptyState
          icon={<StyleSelectorsIcon size={20} />}
          title={translate('selectors.empty.allTitle')}
          description={translate('selectors.empty.noSelectors')}
        />
      );
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}
