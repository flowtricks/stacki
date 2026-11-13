// The grid's named areas: each area's name and placement inputs, the editor
// popover, the list of areas and its edits (GridSettings.tsx).

import { useEffect, useRef, useState } from 'react';
import { GroupLabel } from './TypographySection';
import { parseAreas, serializeAreas, areaLabel, nextAreaName, type GridArea, type GridAreaPatch } from './model/gridTemplate';
import { type SetProp, type ClearProp, type LabelProps, resolvedValue, PlusIcon, TrashIcon } from './GridSettingsKit';
import { TrackPopover } from './TrackEditor';
import { useTranslate } from '../../lib/i18n/useTranslate';

// A crosshair marker for area rows (Webflow's area glyph).
export const AreaIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <rect x="5.5" y="5.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.1" />
    <path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
);

// The area's name field — commits on blur / Enter, keeps the old name if emptied.
// Grid area names are single idents, so whitespace is stripped as you type (a typed
// space would split the name into two cells in grid-template-areas).
export function AreaNameInput({ value, busy, onCommit }: { value: string; busy: boolean; onCommit: (v: string) => void }) {
  const translate = useTranslate();
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setText(value);
    }
  }, [value]);
  const commit = () => {
    const trimmed = text.trim();
    if (trimmed) {
      onCommit(trimmed);
    } else {
      setText(value);
    }
  };
  return (
    <input
      className="u-input embed-editor_size-input"
      value={text}
      spellCheck={false}
      disabled={busy}
      aria-label={translate('style.gridAreas.areaName')}
      onChange={(event) => setText(event.target.value.replace(/\s+/g, ''))}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

// A 1-based grid-cell number field (Column/Row start/end) with ↑/↓ stepping.
export function AreaNumberInput({ value, ariaLabel, busy, onCommit }: { value: number; ariaLabel: string; busy: boolean; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setText(String(value));
    }
  }, [value]);
  const clampCell = (cell: number) => Math.max(1, Math.min(999, cell));
  const commit = (entered: string) => {
    const parsed = parseInt(entered, 10);
    if (Number.isNaN(parsed)) {
      setText(String(value));
      return;
    }
    onCommit(clampCell(parsed));
  };
  return (
    <input
      className="u-input embed-editor_size-input embed-editor_grid-area-num"
      value={text}
      inputMode="numeric"
      spellCheck={false}
      disabled={busy}
      aria-label={ariaLabel}
      onChange={(event) => setText(event.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        commit(text);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          onCommit(clampCell(value + 1));
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          onCommit(clampCell(value - 1));
        }
      }}
    />
  );
}

// The area editor popover body: Name + Position (Column start/end, Row start/end).
export function AreaEditor({ area, busy, onChange }: { area: GridArea; busy: boolean; onChange: (patch: GridAreaPatch) => void }) {
  const translate = useTranslate();
  return (
    <div className="embed-editor_grid-track-editor">
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">{translate('style.gridAreas.name')}</span>
        <AreaNameInput value={area.name} busy={busy} onCommit={(name) => onChange({ name })} />
      </div>
      <div className="embed-editor_size-row embed-editor_grid-area-pos">
        <span className="embed-editor_size-label embed-editor_bg-caption">{translate('style.gridAreas.position')}</span>
        <div className="embed-editor_grid-area-fields">
          <div className="embed-editor_grid-area-pair">
            <div className="embed-editor_grid-area-inputs">
              <AreaNumberInput
                value={area.colStart}
                ariaLabel={translate('style.gridAreas.columnStart')}
                busy={busy}
                onCommit={(cell) => onChange({ colStart: cell })}
              />
              <AreaNumberInput
                value={area.colEnd}
                ariaLabel={translate('style.gridAreas.columnEnd')}
                busy={busy}
                onCommit={(cell) => onChange({ colEnd: cell })}
              />
            </div>
            <span className="embed-editor_grid-area-cap">{translate('style.gridAreas.columnCaption')}</span>
          </div>
          <div className="embed-editor_grid-area-pair">
            <div className="embed-editor_grid-area-inputs">
              <AreaNumberInput
                value={area.rowStart}
                ariaLabel={translate('style.gridAreas.rowStart')}
                busy={busy}
                onCommit={(cell) => onChange({ rowStart: cell })}
              />
              <AreaNumberInput
                value={area.rowEnd}
                ariaLabel={translate('style.gridAreas.rowEnd')}
                busy={busy}
                onCommit={(cell) => onChange({ rowEnd: cell })}
              />
            </div>
            <span className="embed-editor_grid-area-cap">{translate('style.gridAreas.rowCaption')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// The Areas list + editor: add / rename / reposition / remove named grid areas,
// serialized to grid-template-areas. Keyed by name so a reposition doesn't jump the
// open editor.
export function AreasSection({ setProp, labels }: { setProp: SetProp; labels: LabelProps }) {
  const translate = useTranslate();
  const { read, busy, clearProp, onProvenance, onSelectSelector } = labels;
  const areas = parseAreas(resolvedValue(read, 'grid-template-areas'));
  const edits = useAreaEdits({ areas, setProp, clearProp });
  const openArea = edits.openName !== undefined ? areas.find((area) => area.name === edits.openName) : undefined;
  return (
    <section className="embed-editor_grid-section">
      <div className="embed-editor_grid-section-head">
        <span className="embed-editor_grid-section-title">
          <GroupLabel
            label={translate('style.gridAreas.areas')}
            props={['grid-template-areas']}
            read={read}
            busy={busy}
            onClear={() => clearProp('grid-template-areas')}
            onProvenance={onProvenance}
            onSelectSelector={onSelectSelector}
          />
          <span className="embed-editor_grid-section-count">({areas.length})</span>
        </span>
        <button
          type="button"
          className="embed-editor_icon-btn"
          onClick={edits.add}
          disabled={busy}
          title={translate('style.gridAreas.addArea')}
          aria-label={translate('style.gridAreas.addArea')}
        >
          <PlusIcon />
        </button>
      </div>
      {areas.length ? (
        <ul className="embed-editor_grid-track-list">
          {areas.map((area) => (
            <AreaRow key={area.name} area={area} busy={busy} edits={edits} />
          ))}
        </ul>
      ) : (
        <div className="embed-editor_grid-empty">{translate('style.gridAreas.noAreas')}</div>
      )}
      {openArea && edits.anchorElement ? (
        <TrackPopover anchorElement={edits.anchorElement} onClose={() => edits.setOpenName(undefined)}>
          <AreaEditor area={openArea} busy={busy} onChange={(patch) => edits.update(openArea.name, patch)} />
        </TrackPopover>
      ) : undefined}
    </section>
  );
}

export type AreaEdits = ReturnType<typeof useAreaEdits>;

// Which area's editor is open (and the row it hangs from), and the list edits — each
// written back as grid-template-areas, or cleared when none are left.
export function useAreaEdits({ areas, setProp, clearProp }: { areas: GridArea[]; setProp: SetProp; clearProp: ClearProp }) {
  const [openName, setOpenName] = useState<string | undefined>(undefined);
  const [anchorElement, setAnchorElement] = useState<HTMLElement | undefined>(undefined);
  const write = (next: GridArea[]) => {
    const serialized = serializeAreas(next);
    if (serialized) {
      setProp('grid-template-areas', serialized, false);
    } else {
      clearProp('grid-template-areas');
    }
  };
  const add = () => {
    const maxRow = areas.reduce((highest, area) => Math.max(highest, area.rowEnd), 0);
    write([
      ...areas,
      {
        name: nextAreaName(areas),
        colStart: 1,
        colEnd: 1,
        rowStart: maxRow + 1,
        rowEnd: maxRow + 1,
      },
    ]);
  };
  const update = (name: string, patch: GridAreaPatch) => {
    write(areas.map((area) => (area.name === name ? { ...area, ...patch } : area)));
    const renamed = 'name' in patch ? patch.name : '';
    // Follow a rename so the editor stays open.
    if (renamed) {
      setOpenName(renamed);
    }
  };
  const remove = (name: string) => {
    write(areas.filter((area) => area.name !== name));
    setOpenName((previous) => (previous === name ? undefined : previous));
  };
  const openAt = (name: string, element: HTMLElement) => {
    if (openName === name) {
      setOpenName(undefined);
      return;
    }
    setOpenName(name);
    setAnchorElement(element.closest('li') ?? element);
  };
  return { openName, setOpenName, anchorElement, add, update, remove, openAt };
}

export function AreaRow({ area, busy, edits }: { area: GridArea; busy: boolean; edits: AreaEdits }) {
  const translate = useTranslate();
  const isOpen = edits.openName === area.name;
  return (
    <li className={`embed-editor_grid-track ${isOpen ? 'is-open' : ''}`}>
      <div className="embed-editor_grid-track-row">
        <button type="button" className="embed-editor_grid-track-main" onClick={(event) => edits.openAt(area.name, event.currentTarget)} disabled={busy}>
          <span className="embed-editor_grid-track-glyph" aria-hidden="true">
            <AreaIcon />
          </span>
          <span className="embed-editor_grid-track-label">{areaLabel(area, translate)}</span>
        </button>
        <div className="embed-editor_grid-track-actions">
          <button
            type="button"
            className={'embed-editor_grid-track-action ' + 'embed-editor_grid-track-action-danger'}
            onClick={() => edits.remove(area.name)}
            disabled={busy}
            title={translate('style.gridAreas.removeArea')}
            aria-label={translate('style.gridAreas.removeArea')}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    </li>
  );
}
