// The find bar at the top of a chat's transcript: a field, "3 of 12", previous and next, and close.
// Matches are painted with the CSS Custom Highlight API (`::highlight(ai-find)` in transcript.css), so
// nothing is added to the messages' DOM and a streamed reply keeps re-rendering as before. The rules
// (what is searched, the bounds, stepping) are chatFind.ts; this file finds the drawn text and paints.
//
// What a find sees is what the transcript draws: the messages that hold a match are opened first, and
// the transcript shows its earlier rows while a query is typed (TranscriptView.tsx). A match split by
// formatting (half of it bold) is not found, because each text node is searched on its own.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatId } from '../../../../shared/properties/ai/chatModel';
import type { Translator } from '../../../lib/i18n/localeContext';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { chevronUp } from '../../../ui/central/centralGeometry';
import { ChevronDownIcon, CloseIcon, SearchIcon } from '../../../ui/Icons';
import { useShortcutTip } from '../../../ui/shortcutTip';
import type { TranscriptItem } from '../chatReducer';
import { FIND_LIMITS, findQuery, matchingMessageIds, stepMatch, textMatches } from './chatFind';
import { setOpenState } from './transcriptUi';

const ChevronUpIcon = centralIcon(chevronUp);
const HIGHLIGHT_ALL = 'ai-find';
const HIGHLIGHT_CURRENT = 'ai-find-current';
/** Text nodes walked per paint: a window of drawn rows holds far fewer. */
const TEXT_NODES_MAX = 50_000;

export function ChatFindBar({
  chatId,
  items,
  flow,
  focusRequests,
  onQueryChange,
  onClose,
}: {
  readonly chatId: ChatId;
  readonly items: readonly TranscriptItem[];
  /** The transcript's content, whose text is searched; undefined before it is mounted. */
  readonly flow: () => HTMLElement | undefined;
  /** Grows each time the person asks for find again: the field takes focus and selects its text. */
  readonly focusRequests: number;
  readonly onQueryChange: (query: string) => void;
  readonly onClose: () => void;
}) {
  const translate = useTranslate();
  const { formatNumber } = useFormat();
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState<number | undefined>(undefined);
  const [count, setCount] = useState(0);
  const ranges = useRef<readonly Range[]>([]);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [focusRequests]);

  // The messages that hold a match are opened, so a folded one ("Show more") shows it.
  useEffect(() => {
    for (const id of matchingMessageIds(items, query)) {
      setOpenState(chatId, `message:${id}`, { open: true });
    }
  }, [chatId, items, query]);

  // Painted after the frame that drew the opened messages; again whenever the transcript changes.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const root = flow();
      const found = root === undefined ? [] : drawnMatches(root, query);
      ranges.current = found;
      setCount(found.length);
      paint(found, undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, items, query]);

  useEffect(() => {
    const range = current === undefined ? undefined : ranges.current[current];
    paint(ranges.current, range);
    range?.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [current, count]);

  // Closing (or leaving the chat) takes the paint away.
  useEffect(() => () => paint([], undefined), []);

  const step = (direction: 'next' | 'previous'): void => setCurrent((index) => stepMatch(index, ranges.current.length, direction));
  const status = findStatus({ query, count, current, translate, formatNumber });

  return (
    <div className="ai-find" role="search">
      <SearchIcon size={16} className="ai-find-icon" />
      <input
        ref={field}
        className="ai-find-field"
        type="text"
        aria-label={translate('ai.find.label')}
        placeholder={translate('ai.find.placeholder')}
        value={query}
        maxLength={FIND_LIMITS.queryCharsMax}
        onChange={(event) => {
          const next = findQuery(event.target.value);
          setQuery(next);
          setCurrent(undefined);
          onQueryChange(next);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            step(event.shiftKey ? 'previous' : 'next');
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="ai-find-count" aria-live="polite">
        {status}
      </span>
      <FindButton label={translate('ai.find.previous')} shortcut="⇧Enter" disabled={count === 0} onPress={() => step('previous')}>
        <ChevronUpIcon size={16} />
      </FindButton>
      <FindButton label={translate('ai.find.next')} shortcut="Enter" disabled={count === 0} onPress={() => step('next')}>
        <ChevronDownIcon size={16} />
      </FindButton>
      <FindButton label={translate('ai.find.close')} shortcut="Esc" disabled={false} onPress={onClose}>
        <CloseIcon size={16} />
      </FindButton>
    </div>
  );
}

/** An icon button of the bar, told in the app's own tooltip with its key (never a native `title`). */
function FindButton(props: {
  readonly label: string;
  readonly shortcut: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  const tip = useShortcutTip(props.label, props.shortcut);
  return (
    <>
      <button type="button" className="ghost ai-find-button" aria-label={props.label} disabled={props.disabled} onClick={props.onPress} {...tip.props}>
        {props.children}
      </button>
      {tip.tip}
    </>
  );
}

/** What the bar says: nothing before a query, "No matches", "12 matches" before a step, then "3 of 12". */
function findStatus({
  query,
  count,
  current,
  translate,
  formatNumber,
}: {
  readonly query: string;
  readonly count: number;
  readonly current: number | undefined;
  readonly translate: Translator;
  readonly formatNumber: (value: number) => string;
}): string {
  if (query === '') {
    return '';
  }
  if (count === 0) {
    return translate('ai.find.none');
  }
  if (current === undefined || current >= count) {
    return translate('ai.find.count', { count });
  }
  return translate('ai.find.position', { current: formatNumber(current + 1), total: totalLabel(count, formatNumber) });
}

/** "1,000+" once the count reaches the bound, so a capped count does not pass for an exact one. */
function totalLabel(count: number, formatNumber: (value: number) => string): string {
  return count >= FIND_LIMITS.matchesMax ? `${formatNumber(FIND_LIMITS.matchesMax)}+` : formatNumber(count);
}

/** Every match in the drawn text of `root`, in document order, skipping the find bar's own field and the composer. */
function drawnMatches(root: HTMLElement, query: string): readonly Range[] {
  if (query === '') {
    return [];
  }
  const found: Range[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let visited = 0; visited < TEXT_NODES_MAX && found.length < FIND_LIMITS.matchesMax; visited += 1) {
    const node = walker.nextNode();
    if (node === null) {
      break;
    }
    for (const match of textMatches(node.textContent ?? '', query, FIND_LIMITS.matchesMax - found.length)) {
      const range = root.ownerDocument.createRange();
      range.setStart(node, match.start);
      range.setEnd(node, match.start + match.length);
      found.push(range);
    }
  }
  return found;
}

interface HighlightApi {
  readonly set: (name: string, ranges: readonly Range[]) => void;
  readonly remove: (name: string) => void;
}

// The API's two globals (`CSS.highlights` and `Highlight`), found and typed here so the rest never guesses.
// The same lookup as src/features/instructions/codeBlockHighlights.ts, which features/ai may not import.
function highlightApi(): HighlightApi | undefined {
  const css: unknown = Reflect.get(globalThis, 'CSS');
  const Highlight: unknown = Reflect.get(globalThis, 'Highlight');
  if (typeof css !== 'object' || css === null || typeof Highlight !== 'function') {
    return undefined;
  }
  const registry: unknown = Reflect.get(css, 'highlights');
  if (typeof registry !== 'object' || registry === null) {
    return undefined;
  }
  const set: unknown = Reflect.get(registry, 'set');
  const remove: unknown = Reflect.get(registry, 'delete');
  if (typeof set !== 'function' || typeof remove !== 'function') {
    return undefined;
  }
  return {
    set: (name, ranges) => {
      Reflect.apply(set, registry, [name, Reflect.construct(Highlight, ranges)]);
    },
    remove: (name) => {
      Reflect.apply(remove, registry, [name]);
    },
  };
}

/** Paints every match, and the current one on top; a runtime without the API (jsdom) paints nothing. */
function paint(all: readonly Range[], current: Range | undefined): void {
  const api = highlightApi();
  if (api === undefined) {
    return;
  }
  if (all.length === 0) {
    api.remove(HIGHLIGHT_ALL);
    api.remove(HIGHLIGHT_CURRENT);
    return;
  }
  api.set(HIGHLIGHT_ALL, all);
  if (current === undefined) {
    api.remove(HIGHLIGHT_CURRENT);
  } else {
    api.set(HIGHLIGHT_CURRENT, [current]);
  }
}
