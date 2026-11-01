// The pieces the loop's list settings are drawn from: a section's header with
// its add button, a closed filter or sort as a row, and the pop-up its editor
// opens in, under the row (LoopSettings.tsx).

import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import Popup from '../../ui/Popup';
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
} from '../../ui/Icons';
import { type LoopFieldKind } from '../../editor/loopQuery';
import { type RowParts } from './loopSettingsModel';
// One closed filter or sort: the field quieter, what is asked of it brighter,
// and a remove button that shows on hover, as a builder's settings list does.
export function ListRow(props: {
  readonly parts: RowParts;
  readonly open: boolean;
  readonly locked?: boolean;
  readonly removeLabel: string;
  /** The editor shown in a pop-up under the row while it is open. */
  readonly editor?: ReactNode;
  readonly onToggle: () => void;
  readonly onRemove: () => void;
}) {
  const { parts } = props;
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rowRef} className={`loop-settings-item${props.open ? ' open' : ''}`}>
      <button
        type="button"
        className="loop-settings-item-main"
        title={`${parts.lead} ${parts.rest}`}
        disabled={props.locked === true}
        aria-expanded={props.open}
        aria-haspopup="dialog"
        onClick={props.onToggle}
      >
        <span className="loop-settings-item-lead">{parts.lead}</span>
        <span className="loop-settings-item-rest">{parts.rest}</span>
      </button>
      <button
        type="button"
        className="loop-settings-item-remove"
        aria-label={props.removeLabel}
        title="Remove"
        onClick={props.onRemove}
      >
        <TrashIcon size={13} />
      </button>
      {props.open && props.editor !== undefined && (
        <RowPopup anchorRef={rowRef} onClose={props.onToggle}>
          {props.editor}
        </RowPopup>
      )}
    </div>
  );
}

// The editor floats under its row, as a builder's filter pop-up does, so the
// list keeps its place and the row being edited stays in view above it.
const ROW_POPUP_HEIGHT_PX_MAX = 220;

function RowPopup(props: {
  readonly anchorRef: RefObject<HTMLDivElement>;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const [placed, setPlaced] = useState<
    { readonly anchor: HTMLElement; readonly position: FieldPosition } | undefined
  >(undefined);
  const { anchorRef } = props;
  useLayoutEffect(() => {
    const anchor = anchorRef.current ?? undefined;
    if (anchor !== undefined) {
      setPlaced({
        anchor,
        position: dataPickerPosition(anchor.getBoundingClientRect(), {
          heightPxMax: ROW_POPUP_HEIGHT_PX_MAX,
        }),
      });
    }
  }, [anchorRef]);
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
      label="Edit"
    >
      {props.children}
    </Popup>
  );
}

export function SectionHeader(props: {
  readonly title: string;
  readonly addable: boolean;
  readonly extra?: ReactNode;
  readonly onAdd: () => void;
}) {
  return (
    <div className="loop-settings-header">
      <span className="prop-label">{props.title}</span>
      <span className="loop-settings-header-tools">{props.extra}</span>
      <button
        type="button"
        className="loop-settings-add"
        aria-label={`Add ${props.title.toLowerCase()}`}
        title={`Add ${props.title.toLowerCase()}`}
        disabled={!props.addable}
        onClick={props.onAdd}
      >
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

export function EditorRow(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="loop-settings-editor-row">
      <span className="loop-settings-editor-label">{props.label}</span>
      <div className="loop-settings-editor-control">{props.children}</div>
    </div>
  );
}
