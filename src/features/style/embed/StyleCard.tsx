// The style card: its head, the context and source pickers, the sections in
// order with the control each draws, and the rows no section claims
// (EmbedEditor.tsx).

import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Select from '../components/Select';
import ElementTokenPicker from '../ElementTokenPicker';
import SizeSection from '../SizeSection';
import SpacingSection, { SpacingCenterButton } from '../SpacingSection';
import BordersSection from '../BordersSection';
import BackgroundSection from '../BackgroundSection';
import PositionSection from '../PositionSection';
import TypographySection from '../TypographySection';
import FlexChildSection from '../FlexChildSection';
import EffectsSection from '../EffectsSection';
import { groupProps } from '../model/sections';
import { type ResolvedProp, type ResolvedStyle } from '../model/resolved';
import { assert } from '../../../../shared/core/assert';
import { queryKey } from '../model/css';
import { PencilIcon, EmbedIcon, ComponentIcon, breakpointIcon } from './EditorBasics';
import { AddPropertyRow, useSectionVisibility } from './AddProperty';
import {
  SectionBlock,
  ProvenancePopover,
  ResolvedRow,
  DisplayRow,
  LAYOUT_CONTROL_PROPS,
  EFFECTS_CONTROL_PROPS,
  TYPOGRAPHY_CONTROL_PROPS,
} from './ResolvedRows';
import { ALIGN_PROPS, GRID_CONTROL_PROPS, LayoutModeSections, type SourceOption } from './LayoutRows';
import { SelectorPicker, ADD_QUERY, PlusIcon } from './SelectorPicker';
import { AddQueryForm, EditQueryForm, CssCodeSection, type StyleCardProps } from './QueryForms';

export function StyleCard(card: StyleCardProps) {
  const { resolved, busy, activeSelector, onSelectSelector } = card;
  const provenance = useProvenance();
  const [visibleSelectors, rememberVisibleSelectors] = useVisibleSelectors();
  const shown = provenance.shown;
  const provenanceResolved = shown ? resolved.props.get(shown.prop) : undefined;

  return (
    <div className="embed-editor_rule u-surface-surface">
      <StyleCardHead card={card} onVisibleSelectorsChange={rememberVisibleSelectors} />
      {card.sourceNote ? <p className="embed-editor_source-note">{card.sourceNote}</p> : undefined}

      <CssCodeSection
        model={card.model}
        activeSelector={activeSelector}
        visibleSelectors={visibleSelectors}
        editableRule={resolved.selectedRule ?? undefined}
        busy={busy}
        open={card.cssCodeOpen}
        onToggle={card.onToggleCssCode}
        onSave={card.onSaveCssRule}
      />

      <StyleSections card={card} openProvenance={provenance.openProvenance} />

      <div className="embed-editor_rule-foot">
        <AddPropertyRow busy={busy} onAdd={card.onAdd} />
      </div>

      {shown && provenanceResolved !== undefined ? (
        <ProvenancePopover
          prop={shown.prop}
          anchor={shown.rect}
          resolved={provenanceResolved}
          onClose={provenance.closeProvenance}
          onAnchorReclick={provenance.suppressProvenanceReopen}
          onSelectSelector={onSelectSelector}
        />
      ) : undefined}
    </div>
  );
}

// The open provenance popover: which prop + the clicked label's rect (so the popover
// anchors to the bottom of that label, not a fixed corner of the card).
export function useProvenance() {
  const [shown, setShown] = useState<{ prop: string; rect: DOMRect } | undefined>(undefined);
  // When the popover is closed by pressing its own trigger label again, that
  // label's click must not re-open it — this holds that prop so openProvenance
  // skips the reopen once (toggle).
  const suppressProvenance = useRef<string | undefined>(undefined);
  const openProvenance = useCallback((prop: string, rect: DOMRect) => {
    if (suppressProvenance.current === prop) {
      suppressProvenance.current = undefined;
      return;
    }
    suppressProvenance.current = undefined;
    setShown({ prop, rect });
  }, []);
  const closeProvenance = useCallback(() => setShown(undefined), []);
  const suppressProvenanceReopen = useCallback((prop: string) => {
    suppressProvenance.current = prop;
  }, []);
  return { shown, openProvenance, closeProvenance, suppressProvenanceReopen };
}

// The selectors the well is showing, kept as the same array while they don't change.
export function useVisibleSelectors() {
  const [visibleSelectors, setVisibleSelectors] = useState<readonly string[]>([]);
  const rememberVisibleSelectors = useCallback((next: readonly string[]) => {
    setVisibleSelectors((previous) => {
      const same = next.length === previous.length && next.every((selector, index) => selector === previous[index]);
      return same ? previous : [...next];
    });
  }, []);
  return [visibleSelectors, rememberVisibleSelectors] as const;
}

// The card's sticky head: the query/context selector (with its add / rename forms),
// the element's identity, the selector well, and where edits go.
export function StyleCardHead({ card, onVisibleSelectorsChange }: { card: StyleCardProps; onVisibleSelectorsChange: (selectors: readonly string[]) => void }) {
  const { snapshot, activeSelector, busy } = card;
  // Whether the "Add query" form is open (below the context dropdown).
  const [addingQuery, setAddingQuery] = useState(false);
  // The query being renamed, if any — same slot as the add form, one at a time.
  const [editingQuery, setEditingQuery] = useState<string | undefined>(undefined);
  return (
    // The query/context selector leads the panel (and sticks to the top on scroll);
    // its "Add query" option opens the form right below it.
    <div className="embed-editor_head">
      <div className="embed-editor_switchers">
        {/* Always shown (even with only "Base") for a stable panel layout. The last
          option opens a form to add a custom query to the current selector. */}
        {card.contexts.length > 0 ? (
          <ContextSwitcher
            card={card}
            onAddQuery={() => {
              setEditingQuery(undefined);
              setAddingQuery(true);
            }}
            onEditQuery={(query) => {
              setAddingQuery(false);
              setEditingQuery(query);
            }}
          />
        ) : undefined}
      </div>
      <QueryForms card={card} addingQuery={addingQuery} editingQuery={editingQuery} setAddingQuery={setAddingQuery} setEditingQuery={setEditingQuery} />
      <div className="embed-editor_selector">
        <div className="embed-editor_selector-box">
          {snapshot ? <ElementTokenPicker snapshot={snapshot} /> : <div className="embed-editor_element-id is-empty">No element selected</div>}
          {/* Right-aligned slot the save indicator portals into — sits on the
            `div.test` row (see SaveIndicator). */}
          <span id="embed-editor_save-slot" className="embed-editor_selector-save" />
        </div>
      </div>

      {/* Every selector that styles this element — click to edit it (like a combo
        class); the input adds a new one (native for a class[:state], embed for a
        complex selector). Replaces the old None/Hover/Focus/Active switch. */}
      <SelectorPicker
        selectors={card.selectors}
        suggestions={card.suggestions}
        activeSelector={activeSelector}
        activePicked={card.activePicked}
        busy={busy}
        loading={card.resolving}
        onSelect={card.onSelectActive}
        onDeselect={card.onDeselect}
        onAdd={card.onAddSelector}
        onVisibleSelectorsChange={onVisibleSelectorsChange}
      />
      <SourcePickerRow card={card} />
    </div>
  );
}

// The style-context dropdown. Each context row can carry a pencil to rename its query;
// the last option adds a query.
export function ContextSwitcher({ card, onAddQuery, onEditQuery }: { card: StyleCardProps; onAddQuery: () => void; onEditQuery: (query: string) => void }) {
  const { contexts, contextInfos, queryUses } = card;
  const options = contexts.map((styleContext) => {
    // Editable when this stylesheet is where the query is written. A row can be here
    // for a query held in some other file (or for a native breakpoint, which is no
    // at-rule at all) — nothing to rename there, so no pencil. A nested chain's own
    // query is its last link; the ones before it are rows of their own.
    const query = (styleContext.embedAtContext || '').split(' › ').pop() || '';
    const uses = queryUses.get(queryKey(query)) ?? 0;
    return {
      value: styleContext.key,
      label: styleContext.label,
      icon: breakpointIcon(styleContext.breakpoint ?? undefined),
      marked: contextInfos.find((info) => info.key === styleContext.key)?.hasStyles ?? false,
      ...(uses > 0
        ? {
            action: {
              icon: <PencilIcon />,
              label: `Edit ${query}`,
              onSelect: () => onEditQuery(query),
            },
          }
        : {}),
    };
  });
  return (
    <Select
      className="embed-editor_context-select"
      value={card.context}
      options={[...options, { value: ADD_QUERY, label: 'Add query', icon: <PlusIcon /> }]}
      onChange={(next) => {
        if (next === ADD_QUERY) {
          onAddQuery();
        } else {
          card.onContext(next);
        }
      }}
      ariaLabel="Style context"
    />
  );
}

// The add-query and rename-query forms, one at a time, below the context dropdown.
export function QueryForms({
  card,
  addingQuery,
  editingQuery,
  setAddingQuery,
  setEditingQuery,
}: {
  card: StyleCardProps;
  addingQuery: boolean;
  editingQuery: string | undefined;
  setAddingQuery: (adding: boolean) => void;
  setEditingQuery: (query: string | undefined) => void;
}) {
  return (
    <>
      {addingQuery ? (
        <AddQueryForm
          canNest={card.activeSelector.length > 0}
          suggestions={card.querySuggestions}
          onCancel={() => setAddingQuery(false)}
          onAdd={(query, mode) => {
            setAddingQuery(false);
            card.onAddQuery(query, mode);
          }}
        />
      ) : undefined}
      {editingQuery ? (
        <EditQueryForm
          query={editingQuery}
          uses={card.queryUses.get(queryKey(editingQuery)) ?? 0}
          sourceLabel={card.sourceLabel}
          suggestions={card.querySuggestions}
          onCancel={() => setEditingQuery(undefined)}
          onRename={(from, to) => {
            setEditingQuery(undefined);
            card.onRenameQuery(from, to);
          }}
        />
      ) : undefined}
    </>
  );
}

// Where edits go, as a compact text link: the Webflow class style or a specific embed
// (page embeds listed in cascade order). Sits under the selector input, mirroring the
// reference layout.
export function SourcePickerRow({ card }: { card: StyleCardProps }) {
  return (
    <div className="embed-editor_selector-head">
      <div className="embed-editor_source-picker">
        <span className="embed-editor_source-prefix">Add custom styles in:</span>
        {/* Always rendered so it's openable while embeds are still fetching — it
          lists whatever's loaded so far (Webflow + page embeds); component
          embeds fill in as they arrive, flagged by the spinner beside it. */}
        <Select
          variant="link"
          searchable
          searchPlaceholder="Search embeds…"
          className="embed-editor_source-link"
          value={card.sourceValue}
          options={card.sourceOptions.map(sourceSelectOption)}
          onChange={(next) => card.onSourceChange(next)}
          ariaLabel="Style source — the Webflow class or embed edits go to"
        />
        {card.loading ? (
          <span className="embed-editor_source-loading" title="Fetching embeds…" aria-live="polite">
            <svg className="embed-editor_source-spinner" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6" />
            </svg>
          </span>
        ) : undefined}
      </div>
      {card.pending ? (
        <span className="embed-editor_unsaved" title="Not yet saved — applies when you exit the component">
          Unsaved
        </span>
      ) : undefined}
    </div>
  );
}

// A source as a dropdown option. Trigger tag: component embeds show the component icon
// in green, page-level embeds the embed icon in blue.
export function sourceSelectOption(option: SourceOption) {
  return {
    value: option.value,
    label: option.label,
    marked: option.heading ? false : (option.marked ?? false),
    ...(option.heading === undefined ? {} : { heading: option.heading }),
    ...(option.indent === undefined ? {} : { indent: option.indent }),
    ...(option.triggerLabel === undefined ? {} : { triggerLabel: option.triggerLabel }),
    icon: option.heading ? <ComponentIcon /> : <EmbedIcon />,
    triggerIcon: option.fromComponent ? <ComponentIcon /> : <EmbedIcon />,
    tone: option.fromComponent ? ('component' as const) : ('embed' as const),
  };
}

// What every section's controls are handed.
export type SectionCard = Pick<StyleCardProps, 'busy' | 'resolving' | 'setProp' | 'clearProp' | 'liveSetProp' | 'onSelectSelector' | 'activeSelector'> & {
  read: (prop: string) => ResolvedProp | undefined;
  onProvenance: (prop: string, anchor: DOMRect) => void;
};

// The property sections, each collapsible (Shift-click applies to all).
export function StyleSections({ card, openProvenance }: { card: StyleCardProps; openProvenance: (prop: string, anchor: DOMRect) => void }) {
  const { resolved } = card;
  // Always show Layout + Size so the panel is consistent across elements, not
  // only those that already set a property in that section.
  const groups = groupProps([...resolved.props.keys()], SECTION_ORDER);
  const sectionIds = groups.map((group) => group.def.id);
  const [closedSectionIds, toggleSection] = useSectionVisibility();
  const read = (prop: string) => resolved.props.get(prop);
  const section: SectionCard = {
    read,
    busy: card.busy,
    resolving: card.resolving,
    setProp: card.setProp,
    clearProp: card.clearProp,
    liveSetProp: card.liveSetProp,
    onProvenance: openProvenance,
    onSelectSelector: card.onSelectSelector,
    activeSelector: card.activeSelector,
  };
  return (
    <div className="embed-editor_decls">
      {groups.map((group) => (
        <SectionBlock
          key={group.def.id}
          label={group.def.label}
          open={!closedSectionIds.has(group.def.id)}
          onToggle={(event) => {
            const open = !closedSectionIds.has(group.def.id);
            toggleSection({
              id: group.def.id,
              ids: sectionIds,
              next: open ? 'closed' : 'open',
              scope: event.shiftKey ? 'all' : 'one',
            });
          }}
          // A dot whenever anything in the section reaches the element, and
          // blue once the picked selector is one of the things setting it —
          // `source === 'selected'` is the same test every property label in
          // here makes.
          mark={group.props.some((prop) => read(prop)?.source === 'selected') ? 'own' : group.props.length ? 'other' : undefined}
          headerAction={
            group.def.id === 'spacing' ? <SpacingCenterButton read={read} busy={card.busy} setProp={card.setProp} clearProp={card.clearProp} /> : undefined
          }
        >
          {SECTION_CONTROLS[group.def.id]?.(section)}
          <FallThroughRows
            props={fallThroughProps(group.def.id, group.props)}
            emptyNote={isControlSection(group.def.id) ? undefined : EMPTY_CUSTOM_NOTE}
            resolved={resolved}
            section={section}
          />
        </SectionBlock>
      ))}
    </div>
  );
}

export const SECTION_ORDER = ['flex-child', 'layout', 'position', 'spacing', 'size', 'typography', 'backgrounds', 'borders', 'effects', 'other'] as const;

export const EMPTY_CUSTOM_NOTE = 'No custom properties — add one below.';

// Each section's dedicated controls, by section id. A section without an entry (the
// custom properties) is only its fall-through rows. The sections whose live writes
// still hand over a dropped preview as null (Typography, and Flex child through its
// props) get it converted to `undefined` here.
export const SECTION_CONTROLS: Readonly<Record<string, (section: SectionCard) => ReactNode>> = {
  'flex-child': (section) => (
    <FlexChildSection
      key={section.activeSelector}
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={(prop, value, important) => section.liveSetProp(prop, value ?? undefined, important)}
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
  size: (section) => (
    <SizeSection
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={section.liveSetProp}
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
  position: (section) => (
    <PositionSection
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={section.liveSetProp}
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
  borders: (section) => (
    <BordersSection
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={section.liveSetProp}
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
  spacing: (section) => (
    <SpacingSection
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={section.liveSetProp}
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
  backgrounds: (section) => (
    <BackgroundSection
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={section.liveSetProp}
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
  // Keyed by selector so the font/weight custom-mode state resets per element.
  typography: (section) => (
    <TypographySection
      key={section.activeSelector}
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={(prop, value, important) => section.liveSetProp(prop, value ?? undefined, important)}
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
  // Display always shows (defaults to block); Flex / Grid / Inline settings follow in
  // collapsible disclosures that auto-open for the current Display (never hidden).
  // Gap lives inside.
  layout: (section) => (
    <>
      <DisplayRow
        resolved={section.read('display')}
        busy={section.busy}
        setProp={section.setProp}
        clearProp={section.clearProp}
        onProvenance={section.onProvenance}
        onSelectSelector={section.onSelectSelector}
      />
      <LayoutModeSections
        read={section.read}
        busy={section.busy}
        resolving={section.resolving}
        setProp={section.setProp}
        clearProp={section.clearProp}
        liveSetProp={section.liveSetProp}
        onProvenance={section.onProvenance}
        onSelectSelector={section.onSelectSelector}
        activeSelector={section.activeSelector}
      />
    </>
  ),
  effects: (section) => (
    <EffectsSection
      read={section.read}
      busy={section.busy}
      setProp={section.setProp}
      clearProp={section.clearProp}
      liveSetProp={section.liveSetProp}
      onProvenance={section.onProvenance}
      onSelectSelector={section.onSelectSelector}
    />
  ),
};

export function isControlSection(id: string): boolean {
  return SECTION_CONTROLS[id] !== undefined;
}

// The props of a section that its dedicated controls don't own, shown as generic
// rows: typography props without a control (text-transform, font-style, the
// text-decoration shorthand, …); generic layout props (the align + grid props are
// owned by the disclosures, always); effects props without a control
// (transform-origin, perspective, will-change, …). The custom-properties section is
// all rows.
export function fallThroughProps(id: string, props: readonly string[]): readonly string[] {
  switch (id) {
    case 'typography':
      return props.filter((prop) => !TYPOGRAPHY_CONTROL_PROPS.has(prop));
    case 'layout':
      return props.filter((prop) => !LAYOUT_CONTROL_PROPS.has(prop) && !ALIGN_PROPS.has(prop) && !GRID_CONTROL_PROPS.has(prop));
    case 'effects':
      return props.filter((prop) => !EFFECTS_CONTROL_PROPS.has(prop));
    default:
      return isControlSection(id) ? [] : props;
  }
}

// Generic property rows. Every row's name came from `resolved.props.keys()`, so a miss
// is a broken grouping, not an absent property. With no rows, `emptyNote` (if given)
// says so.
export function FallThroughRows({
  props,
  emptyNote,
  resolved,
  section,
}: {
  props: readonly string[];
  emptyNote: string | undefined;
  resolved: ResolvedStyle;
  section: SectionCard;
}) {
  if (!props.length) {
    return emptyNote === undefined ? undefined : <p className="embed-editor_decls-empty">{emptyNote}</p>;
  }
  return props.map((prop) => {
    const found = resolved.props.get(prop);
    assert(found !== undefined, `Grouped property ${prop} is resolved`);
    return (
      <ResolvedRow
        key={prop}
        prop={prop}
        resolved={found}
        busy={section.busy}
        setProp={section.setProp}
        clearProp={section.clearProp}
        liveSetProp={section.liveSetProp}
        onProvenance={section.onProvenance}
        onSelectSelector={section.onSelectSelector}
      />
    );
  });
}
