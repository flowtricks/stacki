import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { VariableBlock, VariableGroup } from './variablesBridge';
import type { WireColumn } from '../../../shared/ipc/ipcResults';
import type { VariableCellProps } from './VariableCell';
import type { VariableSlot, VariableRename, SlotOffset } from './variableRows';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { buildSheetSlots, stemOf, sectionPrefix, rowRenames } from './variableRows';
import type { ScrollLanes } from './variableScroll';
import { useVariableSheetScroll, VariableScrollBar } from './VariableSheetScroll';
import Cell from './VariableCell';
import useListReorder from '../../ui/useListReorder';
import MoreMenu from '../../ui/MoreMenu';
import VariableTypeIcon from './VariableTypeIcon';
import { PencilIcon, CopyIcon, TrashIcon, DragIcon, PlusIcon } from '../../ui/Icons';

type EditName = (name: string) => boolean | void | Promise<boolean | void>;
type AddVariable = (block: VariableBlock, columns: readonly WireColumn[], word: string) => void | Promise<void>;
export interface SheetActions {
  readonly onSave: VariableCellProps['onSave'];
  readonly onMove?: (slots: readonly VariableSlot[], from: number, to: number) => void | Promise<void>;
  readonly onAdd?: AddVariable | undefined;
  readonly onRename?: ((renames: readonly VariableRename[]) => boolean | void | Promise<boolean | void>) | undefined;
  readonly onRetitle?: ((block: VariableBlock, title: string) => boolean | Promise<boolean>) | undefined;
  readonly onDuplicateSection?: ((block: VariableBlock) => void | Promise<void>) | undefined;
  readonly onDeleteSection?: ((block: VariableBlock) => void | Promise<void>) | undefined;
  readonly fluidOf?: VariableCellProps['fluidOf'];
  readonly onDraft?: VariableCellProps['onDraft'];
}
export interface SheetProps extends SheetActions {
  readonly blocks: readonly VariableBlock[];
  readonly group: VariableGroup;
}
interface SectionMenuProps {
  readonly onRename: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
}
interface EditableNameProps {
  readonly value: string;
  readonly onRename?: EditName | undefined;
  readonly className?: string;
  readonly title?: string;
  readonly openSignal?: number;
  readonly children?: React.ReactNode;
}
type Reorder = ReturnType<typeof useListReorder>;
interface NewVariableProps {
  readonly block: VariableBlock;
  readonly columns: readonly WireColumn[];
  readonly onAdd?: AddVariable | undefined;
  readonly template: string;
  readonly slotProps?: ReturnType<Reorder['slotProps']>;
  readonly dropping: boolean;
}
interface TableProps extends SheetActions {
  readonly block: VariableBlock;
  readonly group: VariableGroup;
  readonly sectionDrag: {
    readonly props: React.HTMLAttributes<HTMLElement>;
    readonly className: string;
  };
  readonly scrollLanes: ScrollLanes;
  readonly rowsDrag: Reorder;
  readonly slotOffset?: number;
  readonly showHead?: boolean;
}
const SAVE_ON = ['Enter', 'Tab'];

// The sheet's handlers report a refused edit themselves (a toast, then a
// reload); what reaches here is an edit that could not be attempted at all.
function reportEditFailure(error: unknown): void {
  console.error('[stacki] variable edit failed:', error);
}
const LABEL_TRACKS = 'calc(var(--vars-inset) + 18px) var(--vars-name-col)';
// --vars-col-fit is the widest heading on the page, set by the sheet: every
// value column grows to it together, so tables with the same count still line up.
const valueTracks = (count: number) =>
  `repeat(${count}, minmax(max(var(--vars-col-min), var(--vars-col-fit, 0px)), max(var(--vars-col), var(--vars-col-fit, 0px))))`;
function sheetOffset(offsets: readonly SlotOffset[], index: number): SlotOffset {
  const offset = offsets[index];
  assert(offset !== undefined, 'Variable table: missing block offset');
  assert(offset.rows >= offset.head, 'Variable table: rows precede their heading');
  return offset;
}

function SectionMenu({ onRename, onDuplicate, onDelete }: SectionMenuProps) {
  return (
    <MoreMenu
      className="vars-section-menu"
      title="Group options"
      items={[
        { label: 'Rename', icon: <PencilIcon size={13} />, onSelect: onRename },
        { label: 'Duplicate', icon: <CopyIcon size={13} />, onSelect: onDuplicate },
        { label: 'Delete', icon: <TrashIcon size={13} />, danger: true, onSelect: onDelete },
      ]}
    />
  );
}

function useEditableName(props: EditableNameProps) {
  const { value, onRename, openSignal } = props;

  const [editing, setEditing] = useState(false);
  // The menu's Rename opens the same field the label does: it bumps a counter,
  // and the field takes that as "open now" rather than owning a second way in.
  const seen = useRef(openSignal);
  useEffect(() => {
    if (openSignal === seen.current) {
      return;
    }
    seen.current = openSignal;
    setText(value);
    setEditing(true);
  }, [openSignal, value]);
  const [text, setText] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (!editing) {
      return undefined;
    }
    done.current = false;
    const input = inputRef.current;
    input?.focus();
    input?.select();
    return undefined;
  }, [editing]);

  const rename = async () => {
    if (done.current) {
      return;
    }
    done.current = true;
    const next = text.trim();
    setEditing(false);
    if (!next || next === value) {
      setText(value);
      return;
    }
    // Put the old name back if the rename is refused — the sheet reloads from
    // the file either way, but the field would otherwise sit there showing a
    // name the project does not have.
    const ok = await onRename?.(next);
    if (!ok) {
      setText(value);
    }
  };
  const commit = (): void => {
    void rename().catch(reportEditFailure);
  };
  const cancel = () => {
    done.current = true;
    setEditing(false);
    setText(value);
  };

  return { ...props, editing, setEditing, text, setText, inputRef, commit, cancel };
}
function EditableName(props: EditableNameProps) {
  const state = useEditableName(props);
  return <EditableNameView state={state} />;
}
function EditableNameView({ state }: { readonly state: ReturnType<typeof useEditableName> }) {
  const { value, className, title, children } = state;
  const { editing, setEditing, text, setText, inputRef, commit, cancel } = state;
  if (!editing) {
    return (
      <button
        type="button"
        className={`vars-rename ${className || ''}`}
        // The name fills the row, so it is also where a drag starts. Press and
        // move to drag the row; press and release to rename it.
        data-drag-through=""
        title={title ? `${title} — drag to move, click to rename` : 'Click to rename'}
        onClick={() => {
          setText(value);
          setEditing(true);
        }}
      >
        {children ?? value}
      </button>
    );
  }
  return (
    <input
      ref={inputRef}
      className={`vars-rename-input ${className || ''}`}
      value={text}
      spellCheck={false}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (SAVE_ON.includes(event.key)) {
          event.preventDefault();
          commit();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
}

function useSheet(props: SheetProps) {
  const { blocks, group, onMove: moveSlots } = props;

  // Dragging a variable is one gesture across the whole sheet rather than one
  // per group. A group is a run of lines between two comments in the same rule,
  // so moving a variable INTO a group is the same file edit as moving it within
  // one — but a drag confined to its own table could only ever land in the table
  // it started in, and a drop anywhere else fell through to "the end".
  //
  // Each group contributes its rows plus one slot at its end (the "New variable"
  // line), so a group with no rows of its own is still somewhere you can drop.
  // A heading is in the list too, and drags on its own: moving a comment up
  // past three variables is how those three come to be under it. So the slots
  // are, per group: its heading, its rows, and one at its end.
  const { slots, offsets: slotOffsets } = useMemo(() => buildSheetSlots(blocks), [blocks]);
  const rowsDrag = useListReorder({
    count: slots.length,
    onMove: (from, to) => {
      void Promise.resolve(moveSlots?.(slots, from, to)).catch(reportEditFailure);
    },
  });
  // Owned here rather than by any one table, for the same reason the section
  // drag is: what it coordinates is the tables against each other.
  const scroll = useVariableSheetScroll(blocks, group.columns.length);
  const scrollSync = scroll.sync;
  const scrollLanes = scroll.lanes;

  // The column headings name the selector's modes, not any one group's rows, so
  // they are the sheet's rather than the first table's. Written here, they stay
  // in view over every group under them instead of leaving with the group that
  // happened to be carrying them.
  const headRef = useRef<HTMLDivElement>(null);
  const headStripRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => scrollSync.register(headStripRef.current ?? undefined), [scrollSync]);
  // The group titles come to rest under this, so its height has to be known
  // rather than guessed — a row's height is set in CSS and read here.
  useLayoutEffect(() => {
    const head = headRef.current;
    if (!head || typeof ResizeObserver !== 'function') {
      return undefined;
    }
    // Set on the scroller, not on the head itself: the group titles that read
    // it are siblings, and a custom property travels down rather than across.
    const host = head.parentElement;
    if (!host) {
      return undefined;
    }
    const apply = () => host.style.setProperty('--vars-head-h', `${head.offsetHeight}px`);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(head);
    return () => observer.disconnect();
  }, []);

  const single = group.columns.length === 1;

  return {
    ...props,
    slots,
    slotOffsets,
    rowsDrag,
    scroll,
    scrollSync,
    scrollLanes,
    headRef,
    headStripRef,
    single,
  };
}
export default function Sheet(props: SheetProps) {
  const state = useSheet(props);
  return <SheetView state={state} />;
}
function SheetView({ state }: { readonly state: ReturnType<typeof useSheet> }) {
  const { blocks, group, onSave, onAdd, onRename, onRetitle, onDuplicateSection, onDeleteSection, fluidOf, onDraft } = state;
  const { slotOffsets, rowsDrag, scrollLanes } = state;
  return (
    <div className="vars-sheet">
      <div className="cms-detail-body vars-body" ref={state.scroll.bodyRef}>
        <SheetHeader state={state} />
        {blocks.map((block, index) => (
          <Table
            key={index}
            block={block}
            group={group}
            onSave={onSave}
            sectionDrag={{
              props: block.title !== undefined ? rowsDrag.rowProps(sheetOffset(slotOffsets, index).head) : {},
              className: block.title !== undefined ? rowsDrag.rowClass(sheetOffset(slotOffsets, index).head) : '',
            }}
            onAdd={onAdd}
            onRename={onRename}
            onRetitle={onRetitle}
            onDuplicateSection={onDuplicateSection}
            onDeleteSection={onDeleteSection}
            rowsDrag={rowsDrag}
            slotOffset={sheetOffset(slotOffsets, index).rows}
            fluidOf={fluidOf}
            onDraft={onDraft}
            scrollLanes={scrollLanes}
            // The group's headings are the sheet's now; only a matrix, whose
            // columns are its own, still writes its own.
            showHead={block.kind === 'matrix'}
          />
        ))}
        {!blocks.length && <div className="props-empty">Nothing matches the search.</div>}
      </div>
      <VariableScrollBar scroll={state.scroll} />
    </div>
  );
}

function useNewVariable(props: NewVariableProps) {
  const { block, columns, onAdd } = props;

  const [typing, setTyping] = useState(false);
  const [word, setWord] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (typing) {
      inputRef.current?.focus();
    }
  }, [typing]);

  const add = async () => {
    const next = word.trim();
    setTyping(false);
    setWord('');
    if (next) {
      await onAdd?.(block, columns, next);
    }
  };
  const commit = (): void => {
    void add().catch(reportEditFailure);
  };

  return { ...props, typing, setTyping, word, setWord, inputRef, commit };
}
function NewVariable(props: NewVariableProps) {
  const state = useNewVariable(props);
  return <NewVariableView state={state} />;
}
function NewVariableView({ state }: { readonly state: ReturnType<typeof useNewVariable> }) {
  const { block, template, slotProps, dropping } = state;
  const { typing, setTyping, word, setWord, inputRef, commit } = state;
  if (!typing) {
    return (
      <div className={`vars-row vars-add ${dropping ? 'drop-before' : ''}`} style={{ gridTemplateColumns: template }} {...(slotProps || {})}>
        <span />
        <button className="vars-add-btn" onClick={() => setTyping(true)}>
          <PlusIcon size={11} /> New variable
        </button>
      </div>
    );
  }

  return (
    <div className={`vars-row vars-add ${dropping ? 'drop-before' : ''}`} style={{ gridTemplateColumns: template }} {...(slotProps || {})}>
      <span />
      <span className="vars-add-field">
        <span className="vars-add-stem">{block.kind === 'matrix' ? '…-' : stemOf(block)}</span>
        <input
          maxLength={LIMITS.attrCharsMax}
          ref={inputRef}
          value={word}
          placeholder="name"
          spellCheck={false}
          onChange={(event) => setWord(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setTyping(false);
              setWord('');
            }
          }}
        />
      </span>
    </div>
  );
}

function useVariableTable(props: TableProps) {
  const { block, group, scrollLanes, rowsDrag, slotOffset = 0 } = props;

  // A matrix carries its own columns (the family's prefixes); everything else
  // uses the group's (one per rule).
  const columns = block.kind === 'matrix' ? block.columns : group.columns;
  assert(columns !== undefined, 'Variable table: matrix columns are required');
  assert(columns.length <= LIMITS.scanEntriesMax, 'Variable table: column limit exceeded');
  const single = columns.length === 1;
  // Scrolls with the tables whose columns line up with its own — see
  // createScrollLanes.
  const scrollSync = scrollLanes.lane(columns.length);
  // Two stacks side by side: the labels, which never move, and a scroller
  // holding every value. One grid per row with the label cells stuck to the
  // left was the obvious shape and the wrong one — the values showed through
  // the gaps between the tracks the sticky cells covered, and a rubber-band
  // scroll past either end unsticks them, so the labels rode the bounce.
  // Outside the scroller there is nothing to come unstuck from.
  //
  // Labels stay fixed while value tracks can shrink to their readable minimum
  // before scrolling. The same template sizes headings and rows together, so
  // tables with the same column count stay aligned. The label side's first
  // track is the drag handle plus the sheet's own left inset, so the row reaches
  // the panel's edge and its rule runs edge to edge.
  const labelTemplate = LABEL_TRACKS;
  const valueTemplate = valueTracks(columns.length);
  // This table's slice of the sheet-wide drag (see Sheet).
  const reorder = {
    rowProps: (index: number) => rowsDrag.rowProps(slotOffset + index),
    rowClass: (index: number) => rowsDrag.rowClass(slotOffset + index),
  };
  // A row is two elements now, so hovering one has to light the other: :hover
  // can't reach across, and the highlight is what ties a name to its values.
  const [hovered, setHovered] = useState<number | undefined>(undefined);
  // The heading strip and the rows scroll together; see the note where they
  // are rendered for why they are two boxes rather than one.
  const headRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const removeRows = scrollSync.register(rowsRef.current ?? undefined);
    const removeHead = scrollSync.register(headRef.current ?? undefined);
    return () => {
      removeRows?.();
      removeHead?.();
    };
  }, [scrollSync, props.showHead]);
  // Whether this table's heading is a name its rows share (renameable) or a
  // comment above them (not — see sectionPrefix).
  const prefix = sectionPrefix(block);
  // Bumped by the menu's Rename, which opens the field the heading already has.
  const [renameSignal, setRenameSignal] = useState(0);
  const rowProps = (index: number) => ({
    className: `vars-row ${reorder.rowClass(index)} ${hovered === index ? 'is-hover' : ''}`,
    onMouseEnter: () => setHovered(index),
    onMouseLeave: () => setHovered((at) => (at === index ? undefined : at)),
  });

  return {
    ...props,
    showHead: props.showHead ?? true,
    slotOffset,
    columns,
    single,
    labelTemplate,
    valueTemplate,
    reorder,
    hovered,
    setHovered,
    headRef,
    rowsRef,
    scrollSync,
    prefix,
    renameSignal,
    setRenameSignal,
    rowProps,
  };
}
function Table(props: TableProps) {
  const state = useVariableTable(props);
  return <TableView state={state} />;
}
function TableView({ state }: { readonly state: ReturnType<typeof useVariableTable> }) {
  const { block, onAdd, rowsDrag, slotOffset = 0 } = state;
  const { columns, labelTemplate } = state;
  return (
    <div className="vars-table">
      <div className="vars-fixed">
        {/* Heading and column head travel together, the same as their
            counterparts on the value side — one sticky box each, so neither
            half needs to know how tall the other's heading is. */}
        <TableFixedHead state={state} />
        <TableRowNames state={state} />
        {/* Also the drop slot for the end of this group — see Sheet. */}
        <NewVariable
          block={block}
          columns={columns}
          onAdd={onAdd}
          template={labelTemplate}
          slotProps={rowsDrag.slotProps(slotOffset + block.rows.length)}
          dropping={rowsDrag.dropIndex === slotOffset + block.rows.length}
        />
      </div>

      <div className="vars-scroll">
        {/* The headings sit outside the horizontal scroller and are kept level
            with it by hand. They have to: a box that scrolls in x is a scroll
            container in both axes, and `position: sticky` inside one resolves
            against that box rather than the sheet — so a heading in here rode
            the rows out of sight instead of staying put. Out here it sticks to
            the sheet, and its own scrollLeft is matched to the rows below so
            the columns still line up.

            Empty counterparts to the label side's heading and head rows: they
            carry the same height and the same rule, so the two stacks stay in
            step and each line runs across both. */}
        <TableScrollHead state={state} />
        <TableScrollRows state={state} />
        {/* Adding a variable is a label-side action; values need no extra row. */}
      </div>
    </div>
  );
}

function SheetHeader({ state }: { readonly state: ReturnType<typeof useSheet> }) {
  const { group, headRef, headStripRef, single } = state;
  return (
    <div className="vars-table vars-sheet-head" ref={headRef}>
      <div className="vars-fixed">
        <div className="vars-row is-head" style={{ gridTemplateColumns: LABEL_TRACKS }}>
          <div />
          <div className="vars-head">Name</div>
        </div>
      </div>
      <div className="vars-scroll">
        <div className="vars-scroll-head" ref={headStripRef} data-scroll-lane={group.columns.length}>
          <div className="vars-row is-head" style={{ gridTemplateColumns: valueTracks(group.columns.length) }}>
            {group.columns.map((column) => (
              <div key={column.id} className="vars-head" title={column.selector || column.label}>
                {single && group.kind === 'single' ? 'Value' : column.label}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// A comment heading's menu carries the two things that are not renaming.
function CommentHeading({ state, title }: { readonly state: ReturnType<typeof useVariableTable>; readonly title: string }) {
  const { block, onRetitle, onDuplicateSection, onDeleteSection } = state;
  const { renameSignal, setRenameSignal } = state;
  return (
    <>
      <EditableName className="vars-section-text" value={title} title={title} openSignal={renameSignal} onRename={(next) => onRetitle?.(block, next)} />
      <SectionMenu
        onRename={() => setRenameSignal((signal) => signal + 1)}
        onDuplicate={() => {
          void Promise.resolve(onDuplicateSection?.(block)).catch(reportEditFailure);
        }}
        onDelete={() => {
          void Promise.resolve(onDeleteSection?.(block)).catch(reportEditFailure);
        }}
      />
    </>
  );
}

function TableTitle({ state }: { readonly state: ReturnType<typeof useVariableTable> }) {
  const { block, onRename, sectionDrag, labelTemplate, prefix } = state;
  return (
    <>
      {block.title && (
        // The heading lines up with the names under it, and drags the same way
        // a row does — a group is a run of lines in the file like any other.
        <h3 className={`vars-row vars-section ${sectionDrag?.className || ''}`} style={{ gridTemplateColumns: labelTemplate }} {...(sectionDrag?.props || {})}>
          <span className="vars-grip" title="Drag to reorder">
            <DragIcon size={11} />
          </span>
          {prefix ? (
            // A heading its rows are named after: renaming it renames them.
            <EditableName
              className="vars-section-text"
              value={prefix}
              title={prefix}
              onRename={(next) =>
                onRename?.(
                  block.rows.flatMap((row) =>
                    row.name
                      ? [
                          {
                            from: row.name,
                            to: `--${next.trim().replace(/^--/, '')}-${row.label}`,
                          },
                        ]
                      : [],
                  ),
                )
              }
            />
          ) : block.titleStart !== undefined ? (
            // A heading that is a comment above the names: renaming it writes
            // the comment, and the names underneath are its own business.
            <CommentHeading state={state} title={block.title} />
          ) : (
            <span className="vars-section-text">{block.title}</span>
          )}
        </h3>
      )}
    </>
  );
}

function TableFixedHead({ state }: { readonly state: ReturnType<typeof useVariableTable> }) {
  const { showHead, labelTemplate } = state;
  return (
    <div className="vars-fixed-head">
      <TableTitle state={state} />
      {showHead && (
        <div className="vars-row is-head" style={{ gridTemplateColumns: labelTemplate }}>
          <div />
          <div className="vars-head">Name</div>
        </div>
      )}
    </div>
  );
}

function TableRowNames({ state }: { readonly state: ReturnType<typeof useVariableTable> }) {
  const { block, onRename, labelTemplate, reorder, rowProps } = state;
  return (
    <>
      {block.rows.map((row, index) => (
        <div
          key={row.name || row.label}
          style={{ gridTemplateColumns: labelTemplate }}
          // The row is what gets measured and dragged; the hook already leaves
          // fields and buttons inside it alone, so a drag can start anywhere on
          // the label that is not one.
          {...reorder.rowProps(index)}
          {...rowProps(index)}
        >
          <span className="vars-grip" title="Drag to reorder">
            <DragIcon size={11} />
          </span>
          <div className="vars-name" title={row.name || row.label}>
            <VariableTypeIcon kind={row.cells.find((cell) => cell !== undefined)?.kind ?? ''} />
            <EditableName
              className="vars-name-text"
              value={row.label}
              title={row.name || row.label}
              onRename={(next) => onRename?.(rowRenames(block, row, next))}
            />
          </div>
        </div>
      ))}
    </>
  );
}

function TableScrollHead({ state }: { readonly state: ReturnType<typeof useVariableTable> }) {
  const { block, group, showHead, columns, single, valueTemplate, headRef } = state;
  return (
    <div className="vars-scroll-head" ref={headRef} data-scroll-lane={columns.length}>
      {block.title && (
        // The heading's counterpart carries the same tracks as the rows
        // below it, or it measures the width of the scroller instead of the
        // width of its contents — and its rule stops at the visible edge
        // while every other line runs the full scroll.
        <div className="vars-row vars-section" style={{ gridTemplateColumns: valueTemplate }} aria-hidden="true" />
      )}
      {showHead && (
        <div className="vars-row is-head" style={{ gridTemplateColumns: valueTemplate }}>
          {columns.map((column) => (
            <div key={column.id} className="vars-head" title={column.selector || column.label}>
              {single && group.kind === 'single' ? 'Value' : column.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TableScrollRows({ state }: { readonly state: ReturnType<typeof useVariableTable> }) {
  const { block, onSave, fluidOf, onDraft, scrollSync, columns, valueTemplate, rowsRef, rowProps } = state;
  return (
    <div
      className="vars-scroll-rows"
      ref={rowsRef}
      data-scroll-lane={columns.length}
      onScroll={(event) => {
        const { scrollLeft } = event.currentTarget;
        scrollSync.broadcast(event.currentTarget, scrollLeft);
      }}
    >
      {block.rows.map((row, index) => (
        <div key={row.name || row.label} style={{ gridTemplateColumns: valueTemplate }} {...rowProps(index)}>
          {columns.map((column, at) => (
            <Cell key={column.id} cell={row.cells[at]} onSave={onSave} fluidOf={fluidOf} onDraft={onDraft} />
          ))}
        </div>
      ))}
    </div>
  );
}
