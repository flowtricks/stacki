import { useEffect, useMemo, useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import Dropdown from '../../ui/Dropdown';
import { CmsIcon, FileIcon } from '../../ui/Icons';
import { linkChoices, LINK_ROWS_DRAWN_MAX, templatesToLoad, type LinkChoiceSource, type LinkEntryLoader, type LinkTemplateState } from './linkEntries';
import type { LinkPage } from './linkType';

// The link field's Page tab: a searchable menu of the project's pages, with each template page
// (`/posts/[slug]`) replaced by the entries it renders (linkEntries.ts). Static pages paint at once;
// a template's entries are asked for when the tab opens and arrive as skeleton rows become rows.
// Asking only reads (the dev server's getStaticPaths); choosing a row writes just the href, through
// `onPick`. Hovering or arrowing never writes: the menu's live preview is off.

interface LinkPageChooserProps {
  readonly text: string;
  readonly pages: readonly LinkPage[];
  readonly loadEntries?: LinkEntryLoader | undefined;
  readonly onPick: (route: string) => void;
}

export default function LinkPageChooser({ text, pages, loadEntries, onPick }: LinkPageChooserProps) {
  const translate = useTranslate();
  const states = useTemplateStates(pages, loadEntries);
  const options = useMemo(() => linkChoices(pages, states, text, translate), [pages, states, text, translate]);
  const loading = [...states.values()].some((state) => state.kind === 'loading');
  return (
    <Dropdown
      value={options.some((option) => option.value === text) ? text : ''}
      placeholder={translate('props.link.choosePage')}
      optionLayout="stacked"
      options={options.map(({ source, ...option }) => ({ ...option, icon: linkChoiceIcon(source) }))}
      searchable
      searchPlaceholder={translate('props.link.searchPages')}
      rowsMax={LINK_ROWS_DRAWN_MAX}
      loading={loading}
      livePreview={false}
      onChange={onPick}
    />
  );
}

// A page file reads as a page; a row a CMS template renders reads as CMS, with the icon the CMS panel uses.
function linkChoiceIcon(source: LinkChoiceSource) {
  switch (source) {
    case 'page':
      return <FileIcon size={12} />;
    case 'cms':
      return <CmsIcon size={12} />;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

// One read per template when the tab opens (or the pages or the host change). A host without a loader
// leaves every template unresolved. Bounded: LINK_TEMPLATES_MAX templates, one after another.
function useTemplateStates(pages: readonly LinkPage[], loadEntries: LinkEntryLoader | undefined): ReadonlyMap<string, LinkTemplateState> {
  const [states, setStates] = useState<ReadonlyMap<string, LinkTemplateState>>(() => new Map());
  // Keyed by the template routes, not the pages array: a host may hand over a fresh array each render.
  const routesKey = templatesToLoad(pages).join('\n');
  useEffect(() => {
    const routes = routesKey.length === 0 ? [] : routesKey.split('\n');
    if (loadEntries === undefined || routes.length === 0) {
      setStates(new Map());
      return undefined;
    }
    let live = true;
    setStates(new Map(routes.map((route) => [route, { kind: 'loading' } as const])));
    void (async () => {
      for (const route of routes) {
        const resolved = await loadEntries(route);
        if (!live) {
          return;
        }
        setStates((previous) => new Map(previous).set(route, resolved));
      }
    })();
    return () => {
      live = false;
    };
  }, [routesKey, loadEntries]);
  return states;
}
