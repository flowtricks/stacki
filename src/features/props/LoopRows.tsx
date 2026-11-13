// The pieces the loop's list settings are drawn from: a section's header with
// its add button, a closed filter or sort as a row, and the pop-up its editor
// opens in, under the row (LoopSettings.tsx).

import { useCallback, useLayoutEffect, useState } from 'react';
import type { ReactNode, RefCallback } from 'react';
import Popup from '../../ui/Popup';
import ExprInput from '../../ui/ExprInput';
import { ResetLabel } from '../../ui/ResetLabel';
import { dataPickerPosition } from './dataPickerPosition';
import type { FieldPosition } from './bindingTypes';
import {
  AssetManagerIcon,
  CalendarIcon,
  CollectionIcon,
  FieldNumberIcon,
  FieldSwitchIcon,
  LayersIcon,
  PaperclipIcon,
  PlusIcon,
  TextIcon,
  TrashIcon,
  ChevronRightIcon,
  DragIcon,
} from '../../ui/Icons';
import { type LoopFieldKind } from '../../editor/loopQuery';
import { type RowParts } from './loopSettingsModel';
import { useLocale, useTranslate } from '../../lib/i18n/useTranslate';
// One closed filter or sort: the field quieter, what is asked of it brighter,
// and a remove button that shows on hover, as a builder's settings list does.
export function ListRow(props: {
  readonly parts: RowParts;
  readonly open: boolean;
  readonly locked?: boolean;
  /** Whether a drag can start on the row itself, in a list whose rows reorder. */
  readonly dragThrough?: boolean;
  readonly removeLabel: string;
  /** The editor shown in a pop-up under the row while it is open. */
  readonly editor?: ReactNode;
  readonly onToggle: () => void;
  readonly onRemove: () => void;
}) {
  const translate = useTranslate();
  const { parts } = props;
  // The row element as state, not a ref: a row created open (a filter just
  // added) renders its pop-up in the same pass, before a ref would be set.
  const [row, setRow] = useState<HTMLDivElement | undefined>(undefined);
  // Stable, so React attaches it once rather than on every render.
  const attach = useCallback<RefCallback<HTMLDivElement>>((element) => setRow(element ?? undefined), []);
  return (
    <div ref={attach} className={`loop-settings-item${props.open ? ' open' : ''}`}>
      {/* A row that drags shows its grip while pointed at, as a builder's list does. */}
      {props.dragThrough === true && (
        <span className="loop-settings-item-grip" aria-hidden="true">
          <DragIcon size={12} />
        </span>
      )}
      <button
        type="button"
        className="loop-settings-item-main"
        data-drag-through={props.dragThrough === true ? '' : undefined}
        title={`${parts.lead} ${parts.rest}`}
        disabled={props.locked === true}
        aria-expanded={props.open}
        aria-haspopup="dialog"
        onClick={props.onToggle}
      >
        <span className="loop-settings-item-lead">{parts.lead}</span>
        <span className="loop-settings-item-rest">{parts.rest}</span>
      </button>
      <button type="button" className="loop-settings-item-remove" aria-label={props.removeLabel} title={translate('ui.remove')} onClick={props.onRemove}>
        <TrashIcon size={13} />
      </button>
      {props.open && props.editor !== undefined && (
        <RowPopup anchor={row} onClose={props.onToggle}>
          {props.editor}
        </RowPopup>
      )}
    </div>
  );
}

// The editor floats under its row, as a builder's filter pop-up does, so the
// list keeps its place and the row being edited stays in view above it.
const ROW_POPUP_HEIGHT_PX_MAX = 220;

export function RowPopup(props: {
  readonly anchor: HTMLElement | undefined;
  readonly heightPxMax?: number;
  /** The least width, for a pop-up wider than the row it opens from; it slides left to stay on screen. */
  readonly widthPxMin?: number;
  readonly label?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const translate = useTranslate();
  const [placed, setPlaced] = useState<{ readonly anchor: HTMLElement; readonly position: FieldPosition } | undefined>(undefined);
  const { anchor } = props;
  const heightPxMax = props.heightPxMax ?? ROW_POPUP_HEIGHT_PX_MAX;
  const { widthPxMin } = props;
  useLayoutEffect(() => {
    if (anchor !== undefined) {
      const rectangle = anchor.getBoundingClientRect();
      setPlaced({ anchor, position: dataPickerPosition(rectangle, widthPxMin === undefined ? { heightPxMax } : { heightPxMax, widthPxMin }) });
    }
  }, [anchor, heightPxMax, widthPxMin]);
  if (placed === undefined) {
    return undefined;
  }
  return (
    <Popup
      mode="popover"
      portal={true}
      anchor={placed.anchor}
      onClose={props.onClose}
      className="loop-settings-popup"
      style={placed.position}
      role="dialog"
      label={props.label ?? translate('props.loop.rows.edit')}
    >
      {props.children}
    </Popup>
  );
}

/** Whether a section narrows or orders the list, and how its title's Reset menu clears it. */
export interface SectionReset {
  readonly applied: boolean;
  readonly onReset: () => void;
}

/**
 * A loop section's title: blue while the section is applied, and then, as a set
 * property's label is, a button whose Reset menu clears that section alone.
 * The shared ResetLabel, so the menu, ⌥-click and keyboard match every other set label.
 */
export function AppliedLabel(props: { readonly title: string; readonly reset: SectionReset }) {
  return <ResetLabel label={props.title} active={props.reset.applied} onReset={props.reset.onReset} />;
}

export function SectionHeader(props: {
  readonly title: string;
  readonly addable: boolean;
  readonly extra?: ReactNode;
  /** The purple dot linking the section to a component property (LoopBinding.tsx). */
  readonly dot?: ReactNode;
  /** The label in place of the plain title: a set value's reset label, say. */
  readonly label?: ReactNode;
  /** The `{}` that shows the section as code (LoopSectionCode.tsx). */
  readonly toggle?: ReactNode;
  /** Whether the section narrows or orders the list, which its title then shows in blue, and its reset. */
  readonly reset?: SectionReset;
  readonly onAdd: () => void;
}) {
  const translate = useTranslate();
  const { locale } = useLocale();
  // German nouns keep their capital, so only the other languages lower-case the title.
  const addLabel = translate('props.loop.rows.add', { title: locale === 'de' ? props.title : props.title.toLowerCase() });
  return (
    <div className="loop-settings-header">
      <span className="loop-settings-label">
        {props.label ??
          (props.reset === undefined ? <span className="prop-label">{props.title}</span> : <AppliedLabel title={props.title} reset={props.reset} />)}
        {props.dot}
        {props.toggle}
      </span>
      <span className="loop-settings-header-tools">{props.extra}</span>
      <button type="button" className="loop-settings-add" aria-label={addLabel} title={addLabel} disabled={!props.addable} onClick={props.onAdd}>
        <PlusIcon size={13} />
      </button>
    </div>
  );
}

export function fieldIcon(kind: LoopFieldKind): ReactNode {
  switch (kind) {
    case 'text':
      return <TextIcon size={13} />;
    case 'number':
      return <FieldNumberIcon size={13} />;
    case 'boolean':
      return <FieldSwitchIcon size={13} />;
    case 'date':
      return <CalendarIcon size={13} />;
    case 'list':
      return <LayersIcon size={13} />;
    case 'reference':
      return <PaperclipIcon size={13} />;
    case 'image':
      return <AssetManagerIcon size={13} />;
    case 'other':
      return <CollectionIcon size={13} />;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/**
 * Code typed for a filter or a sort that no menu can say. It is written when
 * the box is left or ⌘↵ is pressed, and only once `check` accepts it, so code
 * that does not parse never reaches the page; until then the reason shows.
 * `check` holds its length too: this editor has no maxLength to stop typing at.
 */
export function CodeBox(props: {
  readonly value: string;
  readonly label: string;
  readonly placeholder: string;
  readonly check: (code: string) => string | undefined;
  readonly onCommit: (code: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const commit = (text: string): void => {
    const code = text.trim();
    if (code === props.value.trim()) {
      setProblem(undefined);
      return;
    }
    const found = props.check(code);
    setProblem(found);
    if (found === undefined) {
      props.onCommit(code);
    }
  };
  return (
    // Capture: ⌘↵ is the editor's own "insert a blank line" once it reaches it.
    <div
      className="loop-settings-code"
      role="group"
      aria-label={props.label}
      onKeyDownCapture={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          commit(draft);
        }
      }}
    >
      <ExprInput
        value={draft}
        placeholder={props.placeholder}
        invalid={problem !== undefined}
        multiline={true}
        wrap={true}
        onChange={setDraft}
        onCommit={commit}
      />
      {problem !== undefined && (
        <span className="loop-settings-code-problem" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}

export function EditorRow(props: { readonly label: string; readonly dot?: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="loop-settings-editor-row">
      <span className="loop-settings-editor-label loop-settings-label">{props.label}</span>
      {/* The dot sits on the control's top-left corner, as a bound field's does. */}
      <div className="loop-settings-editor-control">
        {props.children}
        {props.dot}
      </div>
    </div>
  );
}

/**
 * Explanation the settings don't need to be used: where they are saved, the
 * code a list comes through. Folded under Details by default, so the panel
 * reads as controls; opened when someone wants to know.
 */
export function LoopDetails(props: { readonly children: ReactNode }) {
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  return (
    <div className="loop-lineage">
      <button type="button" className="loop-lineage-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {translate('props.loop.rows.details')}
        <ChevronRightIcon size={10} className={`loop-lineage-chevron${open ? ' open' : ''}`} />
      </button>
      {open && <div className="loop-lineage-body">{props.children}</div>}
    </div>
  );
}
