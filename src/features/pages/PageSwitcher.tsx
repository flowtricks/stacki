import Popup from '../../ui/Popup';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { comparePageNames, isCollectionRoute } from './pageOrder';
import { FileIcon, CmsIcon, ChevronDownIcon, CheckIcon } from '../../ui/Icons';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { pageDisplayLabel } from '../../lib/pageName';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../../shared/properties/i18n/messageRef';

interface Page {
  readonly name: string;
  readonly path: string;
  readonly route: string;
  readonly title?: string | undefined;
}
interface PageSwitcherProps<T extends Page> {
  readonly pages?: readonly T[] | undefined;
  readonly currentPage?: T | undefined;
  readonly onSelect: (page: T) => void;
}
const PageGlyph = ({ page, size }: { readonly page: Page | undefined; readonly size: number }) =>
  isCollectionRoute(page?.name) ? <CmsIcon size={size} /> : <FileIcon size={size} />;

// Keep the selected page object intact: callers may carry source metadata beyond this projection.
export default function PageSwitcher<T extends Page>(props: PageSwitcherProps<T>) {
  const translate = useTranslate();
  const state = usePageSwitcher(props);
  return (
    <>
      <button
        ref={state.buttonRef}
        className={`page-switch-btn ${isCollectionRoute(props.currentPage?.name) ? 'collection' : ''}`}
        title={translate('pages.switcher.switch')}
        aria-label={translate('pages.switcher.current')}
        aria-haspopup="listbox"
        aria-expanded={state.open}
        data-file={props.currentPage?.path}
        onClick={() => state.setOpen((open) => !open)}
      >
        <PageGlyph page={props.currentPage} size={12} />
        <span className="page-switch-label">{props.currentPage ? pageDisplayLabel(props.currentPage, translate) : translate('pages.switcher.none')}</span>
        <ChevronDownIcon size={10} className="page-switch-chevron" />
      </button>
      {state.open && state.position && <PageMenu state={state} currentPage={props.currentPage} />}
    </>
  );
}

function usePageSwitcher<T extends Page>({ pages, currentPage, onSelect }: PageSwitcherProps<T>) {
  assert((pages?.length ?? 0) <= LIMITS.scanEntriesMax, 'PageSwitcher: page limit exceeded');
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const position = usePagePosition(buttonRef, { open });
  const filtered = pageSwitcherFilter(pages, query, translate);
  // Read when the menu opens, not as effect dependencies: a page list that
  // changes while the menu is open must not clear the search the user typed.
  const opening = useRef({ pages, currentPage });
  opening.current = { pages, currentPage };
  useEffect(() => {
    if (!open) {
      return;
    }
    setQuery('');
    // Open on the page being edited, not the first row, so the highlight and
    // the check agree and Enter keeps the current page.
    setHighlight(pageSwitcherOpeningIndex(pageSwitcherFilter(opening.current.pages, '', translate), opening.current.currentPage));
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open, translate]);
  const pick = (page: T | undefined): void => {
    setOpen(false);
    if (page && page.path !== currentPage?.path) {
      onSelect(page);
    }
  };
  return {
    open,
    setOpen,
    query,
    setQuery,
    highlight,
    setHighlight,
    buttonRef,
    popupRef,
    inputRef,
    position,
    filtered,
    pick,
  };
}

function usePagePosition(buttonRef: RefObject<HTMLButtonElement>, { open }: { readonly open: boolean }) {
  const [position, setPosition] = useState<{ readonly left: number; readonly top: number } | undefined>(undefined);
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) {
      return;
    }
    const rectangle = buttonRef.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(window.innerWidth - 288, rectangle.left + rectangle.width / 2 - 140)),
      top: rectangle.bottom + 6,
    });
  }, [open, buttonRef]);
  return position;
}

type PageState<T extends Page> = ReturnType<typeof usePageSwitcher<T>>;
function PageMenu<T extends Page>({ state, currentPage }: { readonly state: PageState<T>; readonly currentPage: T | undefined }) {
  const translate = useTranslate();
  const onInputKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        state.setHighlight((index) => Math.min(index + 1, state.filtered.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        state.setHighlight((index) => Math.max(index - 1, 0));
        break;
      case 'Enter':
        event.preventDefault();
        if (state.filtered.length) {
          state.pick(state.filtered[Math.min(state.highlight, state.filtered.length - 1)]);
        }
        break;
    }
  };
  return (
    <Popup mode="popover" portal={false} onClose={() => state.setOpen(false)} ref={state.popupRef} className="page-menu" style={state.position ?? undefined}>
      <input
        ref={state.inputRef}
        className="page-menu-search"
        aria-label={translate('pages.switcher.search')}
        value={state.query}
        placeholder={translate('pages.switcher.searchPlaceholder')}
        spellCheck={false}
        onChange={(event) => {
          state.setQuery(event.target.value);
          state.setHighlight(0);
        }}
        onKeyDown={onInputKey}
      />
      <div className="page-menu-list" role="listbox" aria-label={translate('pages.title')}>
        {state.filtered.map((page, index) => (
          <PageRow
            key={page.path}
            page={page}
            current={page.path === currentPage?.path}
            highlighted={index === state.highlight}
            onHover={() => state.setHighlight(index)}
            onPick={() => state.pick(page)}
          />
        ))}
        {state.filtered.length === 0 && <div className="page-menu-empty">{translate('pages.switcher.empty')}</div>}
      </div>
    </Popup>
  );
}

function PageRow({
  page,
  current,
  highlighted,
  onHover,
  onPick,
}: {
  readonly page: Page;
  readonly current: boolean;
  readonly highlighted: boolean;
  readonly onHover: () => void;
  readonly onPick: () => void;
}) {
  const translate = useTranslate();
  const collection = isCollectionRoute(page.name) ? 'collection' : '';
  return (
    <div
      role="option"
      aria-selected={current}
      data-file={page.path}
      className={`page-menu-item ${collection} ${highlighted ? 'highlight' : ''} ${current ? 'current' : ''}`}
      onMouseEnter={onHover}
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse' && event.button === 0) {
          event.preventDefault();
          onPick();
        }
      }}
      onClick={onPick}
    >
      <PageGlyph page={page} size={12} />
      <span className="page-menu-name">{pageDisplayLabel(page, translate)}</span>
      <span className="page-menu-route">{page.route}</span>
      {current && <CheckIcon size={11} />}
    </div>
  );
}

/** The row the menu opens on: the current page's row, or the first when the current page is not listed. */
export function pageSwitcherOpeningIndex(pages: readonly Page[], currentPage: Page | undefined): number {
  const index = currentPage === undefined ? -1 : pages.findIndex((page) => page.path === currentPage.path);
  const opening = index < 0 ? 0 : index;
  assert(opening >= 0, 'PageSwitcher: opening row is negative');
  assert(pages.length === 0 || opening < pages.length, 'PageSwitcher: opening row is past the list');
  return opening;
}

function pageSwitcherFilter<T extends Page>(pages: readonly T[] | undefined, query: string, translate: Translator): T[] {
  const search = query.trim().toLowerCase();
  return (pages || [])
    .filter(
      (page) =>
        !search ||
        page.name.toLowerCase().includes(search) ||
        pageDisplayLabel(page, translate).toLowerCase().includes(search) ||
        page.route.toLowerCase().includes(search),
    )
    .sort((left, right) => comparePageNames(left.name, right.name));
}
