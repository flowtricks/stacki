// The layout section's rows: which properties each section owns, direction
// and alignment, and the sections a display mode brings (EmbedEditor.tsx).

import { useEffect, useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';
import FieldLabel from '../components/FieldLabel';
import { PropTip } from '../components/CssPropertyTip';
import DirectionControl from '../DirectionControl';
import AlignControl from '../AlignControl';
import GapControl from '../GapControl';
import GridControls from '../GridControls';
import { GroupLabel } from '../TypographySection';
import { type MatchedSelector, type ResolvedProp } from '../model/resolved';
import { selectorDependsOnAncestor } from '../model/selectors';
import { getHost, onHostChange } from '../model/host';
import { type LiveSetProp } from './EditorBasics';
import { VALIGN_DISPLAYS, VerticalAlignRow, effectiveValue, rawEffective, currentFlexFlow } from './ResolvedRows';

// The flex Direction control — only rendered when `display` is flex. Writes the
// `flex-direction` + `flex-wrap` longhands; the label clears them (and any legacy
// `flex-flow`).
export function DirectionRow({
  read,
  busy,
  setProp,
  clearProp,
  onProvenance,
  onSelectSelector,
}: {
  read: (prop: string) => ResolvedProp | undefined;
  busy: boolean;
  setProp: (prop: string, value: string, important: boolean) => void;
  clearProp: (prop: string | string[]) => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  return (
    <div className="embed-editor_size-row">
      <GroupLabel
        label="Direction"
        props={['flex-flow', 'flex-direction', 'flex-wrap']}
        read={read}
        busy={busy}
        onClear={() => clearProp(['flex-flow', 'flex-direction', 'flex-wrap'])}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <DirectionControl
        value={currentFlexFlow(read)}
        rawDirection={rawEffective(read('flex-direction')).value}
        important={rawEffective(read('flex-direction')).important}
        busy={busy}
        onCommit={(direction, wrap) => {
          // Two longhand writes: safe together — native ops serialize, and two edits
          // to one embed rule both land before either save.
          setProp('flex-direction', direction, false);
          setProp('flex-wrap', wrap, false);
        }}
        onCommitCustom={(value, important) => setProp('flex-direction', value, important)}
      />
    </div>
  );
}

// The flex Align control — only rendered when `display` is flex. Its X / Y dropdowns
// write `justify-content` / `align-items` (mapped to the screen axis via the current
// flex-direction), and each carries its own clearable label so the two axes reset
// independently; the row's "Align" caption is inert.
export const ALIGN_PROPS = new Set(['justify-content', 'align-items']);
// Grid props owned by the dedicated GridControls block (and the "Configure grid"
// panel) — kept out of the generic fall-through rows when the element is a grid
// container (they'd otherwise double up). grid-auto-columns/-rows live in Configure grid.
export const GRID_CONTROL_PROPS = new Set([
  'grid-template-columns',
  'grid-template-rows',
  'grid-template-areas',
  'grid-auto-flow',
  'grid-auto-columns',
  'grid-auto-rows',
  'justify-items',
  'align-items',
  'justify-content',
  'align-content',
]);

export function AlignRow({
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: {
  read: (prop: string) => ResolvedProp | undefined;
  busy: boolean;
  setProp: (prop: string, value: string, important: boolean) => void;
  clearProp: (prop: string | string[]) => void;
  liveSetProp: LiveSetProp;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const column = currentFlexFlow(read).startsWith('column');
  return (
    <div className="embed-editor_size-row embed-editor_align-row">
      {/* Inert caption — the X / Y labels own clear / provenance per axis. */}
      <FieldLabel
        className="embed-editor_size-label"
        active={false}
        disabled={busy}
        onReset={() => {}}
        tooltip={<PropTip props={['justify-content', 'align-items']} />}
      >
        Align
      </FieldLabel>
      <AlignControl
        justify={effectiveValue(read('justify-content'))}
        align={effectiveValue(read('align-items'))}
        column={column}
        busy={busy}
        read={read}
        onSet={(prop, value) => setProp(prop, value, false)}
        onLive={(prop, value) => liveSetProp(prop, value, false)}
        onClear={(prop) => clearProp(prop)}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
    </div>
  );
}

export const ChevronRightIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
    <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Which layout-mode disclosure a Display value implies. `grid` wins over `inline` for
// `inline-grid`, `flex` over `inline` for `inline-flex`; a custom value (e.g.
// `grid !important`, `var(--grid)`) matches by substring so it still opens its section.
export function layoutMode(display: string): 'grid' | 'flex' | 'inline' | undefined {
  const lowered = display.toLowerCase();
  if (lowered.includes('grid')) {
    return 'grid';
  }
  if (lowered.includes('flex')) {
    return 'flex';
  }
  if (lowered.includes('inline')) {
    return 'inline';
  }
  return undefined;
}

// A collapsible disclosure (Webflow's "More alignment options" button): a full-width
// header whose chevron rotates open to reveal its rows.
export function LayoutDisclosure({ label, open, onToggle, children }: { label: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className={`embed-editor_disclosure ${open ? 'is-open' : ''}`}>
      <button type="button" className="embed-editor_disclosure-btn" aria-expanded={open} onClick={onToggle}>
        <span className={`embed-editor_disclosure-arrow ${open ? 'is-open' : ''}`}>
          <ChevronRightIcon />
        </span>
        <span className="embed-editor_disclosure-label">{label}</span>
      </button>
      {open ? <div className="embed-editor_disclosure-body">{children}</div> : undefined}
    </div>
  );
}

// Flex / Grid / Inline settings as collapsible disclosures. All three always render
// (nothing is hidden by Display); changing Display auto-opens the matching one and
// closes the others, while each stays hand-toggleable between Display changes.
export interface LayoutRowProps {
  read: (prop: string) => ResolvedProp | undefined;
  busy: boolean;
  setProp: (prop: string, value: string, important: boolean) => void;
  clearProp: (prop: string | string[]) => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}

export function LayoutModeSections({
  liveSetProp,
  activeSelector,
  resolving,
  ...rowProps
}: LayoutRowProps & {
  liveSetProp: LiveSetProp;
  activeSelector: string;
  resolving: boolean;
}) {
  const { read, busy, setProp, clearProp, onProvenance, onSelectSelector } = rowProps;
  const display = effectiveValue(read('display'));
  const mode = layoutMode(display);
  const [open, toggle] = useLayoutModeOpen(mode, { resolving });
  // A gap set in ANY spelling keeps the Gap row visible (it reads all of them).
  const hasGridGap = ['row-gap', 'column-gap', 'grid-row-gap', 'grid-column-gap', 'gap'].some((prop) => read(prop) !== undefined);
  return (
    <>
      <LayoutDisclosure label="Flex settings" open={open.flex} onToggle={() => toggle('flex')}>
        <DirectionRow {...rowProps} />
        <AlignRow {...rowProps} liveSetProp={liveSetProp} />
      </LayoutDisclosure>
      <LayoutDisclosure label="Grid settings" open={open.grid} onToggle={() => toggle('grid')}>
        <GridControls {...rowProps} liveSetProp={liveSetProp} />
      </LayoutDisclosure>
      {/* Gap is shared by flex + grid — always mounted (keeps its link-toggle state),
          shown whenever the element is a flex/grid container. */}
      <GapControl key={activeSelector} show={mode === 'flex' || mode === 'grid' || hasGridGap} {...rowProps} liveSetProp={liveSetProp} />
      <LayoutDisclosure label="Inline settings" open={open.inline} onToggle={() => toggle('inline')}>
        {/* Align Y = vertical-align: the inline-level alignment property. Dimmed unless
            Display is inline-level or table-cell, where it actually applies. */}
        <VerticalAlignRow
          resolved={read('vertical-align')}
          dimmed={!VALIGN_DISPLAYS.has(display || 'block')}
          busy={busy}
          setProp={setProp}
          clearProp={clearProp}
          onProvenance={onProvenance}
          onSelectSelector={onSelectSelector}
        />
      </LayoutDisclosure>
    </>
  );
}

// Which disclosures are open. Changing Display's mode opens the matching one and
// closes the others; hand-toggles persist between changes.
export function useLayoutModeOpen(mode: ReturnType<typeof layoutMode>, options: { readonly resolving: boolean }) {
  const { resolving } = options;
  const [open, setOpen] = useState({
    flex: mode === 'flex',
    grid: mode === 'grid',
    inline: mode === 'inline',
  });
  useLayoutEffect(() => {
    // Resolution briefly removes `display` from the model. Keep the disclosure
    // that was already open through that gap; closing it would remove controls
    // for one paint, only to insert them again when the same display returns.
    if (resolving && mode === undefined) {
      return;
    }
    setOpen({ flex: mode === 'flex', grid: mode === 'grid', inline: mode === 'inline' });
  }, [mode, resolving]);
  const toggle = (key: 'flex' | 'grid' | 'inline') => setOpen((previous) => ({ ...previous, [key]: !previous[key] }));
  return [open, toggle] as const;
}

// ─────────────────────────── Style card ───────────────────────────

// One entry in the source dropdown: the Webflow class layer, or a specific embed.
// `value` is 'native' or the embed's key; `marked` dots embeds that already carry
// a rule for this element; `fromComponent` flags a component-shared embed.
export type SourceOption = {
  value: string;
  label: string;
  marked?: boolean;
  fromComponent?: boolean;
  /** A non-selectable component subheader grouping the embeds beneath it. */
  heading?: boolean;
  /** Nested under a component subheader (indented in the list). */
  indent?: boolean;
  /** Full name shown on the closed trigger (e.g. "Global Styles #1"), while the
   *  list row stays the group-scoped "Embed #1". */
  triggerLabel?: string;
};

// A selector the element can be targeted by, offered as an autocomplete suggestion:
// its tag, each class, each data attribute (presence then valued), and its combo
// class chains.
export type SelectorSuggestion = {
  selector: string;
  kind: 'tag' | 'class' | 'attribute' | 'attribute-value' | 'combo';
};

// Every class in the project, kept in step with the app (the same list the Settings
// panel's class field autocompletes from).
export function useProjectClasses(): string[] {
  const [list, setList] = useState<string[]>(() => getHost().projectClasses ?? []);
  useEffect(() => {
    const sync = () =>
      setList((previous) => {
        const next = getHost().projectClasses ?? [];
        return next.length === previous.length && next.every((name, i) => name === previous[i]) ? previous : next;
      });
    sync();
    return onHostChange(sync);
  }, []);
  return list;
}
// How many project-wide classes the suggestion list will show for one query — enough
// to pick from, few enough that the list stays a list.
export const PROJECT_CLASS_LIMIT = 30;

export const SUGGESTION_KIND_LABEL: Record<SelectorSuggestion['kind'], string> = {
  tag: 'tag',
  class: 'class',
  attribute: 'attribute',
  'attribute-value': 'attribute',
  combo: 'combo',
};

// A selector made only from tags, universal selectors, and pseudos describes a
// project-wide group rather than this element's identity. A class, id, or attribute
// anywhere in the selector (including inside `:is(...)`) makes it specific.
export function isGlobalSelector(text: string): boolean {
  return !/[.#[]/.test(text);
}

export type ClassifiedSelector = {
  readonly selector: MatchedSelector;
  readonly global: boolean;
  readonly inherited: boolean;
};

export function classifySelector(selector: MatchedSelector): ClassifiedSelector {
  const inherited = selectorDependsOnAncestor(selector.text);
  return {
    selector,
    // Parent-qualified selectors have the more useful category when the two
    // definitions overlap, so each reveal control owns a disjoint list.
    global: !inherited && isGlobalSelector(selector.text),
    inherited,
  };
}

export function selectorAccessibleLabel(entry: ClassifiedSelector, label: string): string {
  const categories: string[] = [];
  if (entry.global) {
    categories.push('global');
  }
  if (entry.inherited) {
    categories.push('inherited');
  }
  if (entry.selector.fromComponent) {
    categories.push('component');
  }
  if (categories.length === 0) {
    return label;
  }
  return `${label}, ${categories.join(' and ')} selector`;
}

// The selector picker: a chip per selector that styles the element (its own
// classes, stateful, and complex/ancestor selectors), plus an input to add a new
// one. Clicking a chip makes it the edit target (like clicking a combo class);
// the active selector's chip is highlighted, a not-yet-created one dashed. The
// input offers an autocomplete list of the element's targetable selectors:
// ↑/↓ move, Enter applies the highlighted one (or the typed text), Tab fills it
// into the input to keep typing.
export type SelectorPickerProps = {
  selectors: MatchedSelector[];
  suggestions: SelectorSuggestion[];
  activeSelector: string;
  /** True when the active selector is one the user clicked or typed, rather than
   *  the panel's auto-composed default. */
  activePicked: boolean;
  busy: boolean;
  /** Still scanning — the chips that will fill this well are on their way. */
  loading: boolean;
  onSelect: (selector: string) => void;
  onDeselect: () => void;
  onAdd: (selector: string) => void;
  onVisibleSelectorsChange?: (selectors: readonly string[]) => void;
};
