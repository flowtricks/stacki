import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onVariablesChanged } from '../../ipc/editorEnvironment';
import type { VariableBlock, VariableCell, VariableFile, VariableSelection } from './variablesBridge';
import type { WireColumn } from '../../../shared/ipc/ipcResults';
import type { VariableSlot, VariableRename } from './variableRows';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { definedFields } from '../../../shared/core/boundary';
import { variableEdit as bridge } from '../../ipc/variableEditBridge';
import { createVariableHistory, type VariableUndo } from './variableHistory';
import { createVariableRefresh } from './variableRefresh';
import { dropPlan, stemOf } from './variableRows';
import { fluidCheck, resolveValue } from './fluid';
import { getHost, setHost } from '../style/model/host';
import { CloseIcon, CheckIcon } from '../../ui/Icons';
import Sheet from './VariableTable';
import DockableWindow, { type WindowMode } from '../../ui/DockableWindow';
import { readWindowMode, storeWindowMode } from '../../ui/windowPreferences';
import '../style/utilities.css';
export { dropPlan, movesForDrop } from './variableRows';
export { createScrollSync } from './variableScroll';
export { friendlyError } from '../../ipc/variableEditBridge';

const WINDOW_MODE_KEY = 'stacki.window.variables.mode';

export interface VariablesViewProps {
  readonly project: { readonly path: string };
  readonly selected?: VariableSelection | undefined;
  readonly hidden?: boolean;
  readonly onClose?: () => void;
  readonly onDock?: () => void;
  readonly showToast?: ((message: string, kind: 'error') => void) | undefined;
  readonly onRecordUndo?: ((command: VariableUndo) => void) | undefined;
}
function useVariablesView(props: VariablesViewProps) {
  const model = useVariableModel(props);
  const { project, refresh, showToast, onRecordUndo } = model;
  const writeWithUndo = createVariableHistory({
    projectPath: project.path,
    refresh,
    report: (message) => showToast?.(message, 'error'),
    record: onRecordUndo,
  });
  const save = useVariableSave(model, writeWithUndo);
  const move = useVariableMove(model, writeWithUndo);
  const add = useVariableAdd(model, writeWithUndo);
  const rename = useVariableRename(model);
  const retitle = useVariableRetitle(model, writeWithUndo);
  const sections = useVariableSections(model, writeWithUndo);
  const drafts = useVariableDrafts(model);
  return { ...model, ...save, ...move, ...add, ...rename, ...retitle, ...sections, ...drafts };
}

export default function VariablesView(props: VariablesViewProps) {
  const state = useVariablesView(props);
  const [mode, setMode] = useState(() => readWindowMode(WINDOW_MODE_KEY));
  const changeMode = (next: WindowMode): void => {
    setMode(next);
    storeWindowMode(WINDOW_MODE_KEY, next);
    if (next === 'docked') {
      props.onDock?.();
    }
  };
  return <VariablesViewBody state={state} mode={mode} onModeChange={changeMode} />;
}
function VariablesViewBody({
  state,
  mode,
  onModeChange,
}: {
  readonly state: ReturnType<typeof useVariablesView>;
  readonly mode: WindowMode;
  readonly onModeChange: (mode: WindowMode) => void;
}) {
  const { hidden, file, group } = state;
  if (!group) {
    return undefined;
  }

  assert(file !== undefined, 'VariablesView: group must belong to a file');
  return (
    <DockableWindow
      mode={mode}
      onModeChange={onModeChange}
      label="Variables"
      className="vars-view"
      hidden={hidden ?? false}
      minimumSize={{ width: 560, height: 280 }}
      storageKey="stacki.window.variables"
      header={<VariablesWindowHeader state={state} />}
    >
      <Sheet
        blocks={state.blocks}
        group={group}
        onSave={state.save}
        onMove={state.move}
        onAdd={state.add}
        onRename={state.rename}
        onRetitle={state.retitle}
        onDuplicateSection={state.duplicateSection}
        onDeleteSection={state.deleteSection}
        fluidOf={state.fluidOf}
        onDraft={state.noteDraft}
      />
    </DockableWindow>
  );
}

function VariablesWindowHeader({ state }: { readonly state: ReturnType<typeof useVariablesView> }) {
  return (
    <>
      <div className="vars-window-heading">
        <button className="ghost cms-back" title="Close" onClick={state.onClose}>
          <CloseIcon size={13} />
        </button>
        <span className="cms-detail-title" title={state.group?.label}>
          {state.group?.label}
        </span>
        <span className={`cms-saved ${state.saved ? 'on' : ''}`}>
          <CheckIcon size={11} /> Saved
        </span>
      </div>
      <input
        maxLength={LIMITS.attrCharsMax}
        className="vars-search"
        value={state.query}
        placeholder="Search variables"
        spellCheck={false}
        onChange={(event) => state.setQuery(event.target.value)}
      />
      <span className="cms-detail-path" title={state.file?.rel}>
        {state.file?.rel}
      </span>
    </>
  );
}

function headingRange(block: VariableBlock) {
  if (block.titleStart === undefined || block.titleEnd === undefined || block.title === undefined) {
    return undefined;
  }
  assert(block.titleEnd >= block.titleStart, 'Variable heading: range is reversed');
  return { start: block.titleStart, end: block.titleEnd, expect: block.title };
}
function useSavedIndicator() {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const markSaved = useCallback(() => {
    if (!live.current) {
      return;
    }
    clearTimeout(timer.current);
    setSaved(true);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      setSaved(false);
    }, 1200);
  }, []);
  return { saved, markSaved };
}
function useVariableData(
  projectPath: string,
  showToast: VariablesViewProps['showToast'],
  setDrafts: React.Dispatch<React.SetStateAction<Readonly<Record<string, string>>>>,
) {
  const [snapshot, setSnapshot] = useState<{
    readonly files: readonly VariableFile[];
    readonly values: Readonly<Record<string, string>>;
  }>({ files: [], values: {} });
  const currentRead = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    const reader = createVariableRefresh(projectPath, (result) => {
      setSnapshot(result.ok ? result.value : { files: [], values: {} });
      if (!result.ok) {
        showToast?.(result.error, 'error');
      }
      setDrafts({});
    });
    currentRead.current = reader.refresh;
    void reader.refresh();
    const unsubscribe = onVariablesChanged(() => {
      void reader.refresh();
    });
    return () => {
      unsubscribe();
      reader.dispose();
    };
  }, [projectPath, showToast, setDrafts]);
  const refresh = useCallback(() => currentRead.current(), []);
  return { ...snapshot, refresh };
}

function useVariableModel(props: VariablesViewProps) {
  const { project, selected, showToast } = props;

  const { saved, markSaved } = useSavedIndicator();
  const [query, setQuery] = useState('');
  // What is being typed, by variable name, before it has been saved. A clamp()
  // is only as accessible as the numbers it references, and those are usually
  // three rows further down the same table — so the badge has to be recomputed
  // from the draft, not from the file.
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  // `move` is defined above the point where the selected file is worked out, and
  // a drop needs to know which file it is writing to — so it reads it from here.
  const fileRef = useRef<VariableFile | undefined>(undefined);
  const firstSelectorRef = useRef(':root');

  const { files, values, refresh } = useVariableData(project.path, showToast, setDrafts);

  // The variable picker inside a field reads the project from the style panel's
  // shared host, which is set while that panel is mounted — and it is not,
  // unless an element is selected. Set it here too, so a chip can be swapped
  // from this sheet on its own.
  useEffect(() => {
    setHost({ ...getHost(), projectPath: project.path });
  }, [project.path]);

  const file = files.find((candidate) => candidate.rel === selected?.file);
  const group = selected ? file?.groups[selected.index] : undefined;
  fileRef.current = file || undefined;
  firstSelectorRef.current = group?.columns?.[0]?.selector || ':root';

  return {
    ...props,
    files,
    values,
    refresh,
    saved,
    markSaved,
    query,
    setQuery,
    drafts,
    setDrafts,
    fileRef,
    firstSelectorRef,
    file,
    group,
  };
}
type VariableModel = ReturnType<typeof useVariableModel>;
type VariableHistory = ReturnType<typeof createVariableHistory>;
function useVariableSave(model: VariableModel, writeWithUndo: VariableHistory) {
  const { project, showToast, refresh, markSaved } = model;

  const save = useCallback(
    async (cell: VariableCell, value: string) => {
      // One step per value, not per keystroke: the field writes as it is typed
      // and the burst collapses on the key.
      await writeWithUndo(cell.file, 'the value', `var:${cell.file}:${cell.name}`, async () => {
        const result = await bridge('setCssVariable', {
          projectPath: project.path,
          file: cell.file,
          valueStart: cell.valueStart,
          valueEnd: cell.valueEnd,
          expect: cell.value,
          value,
        });
        if (!result.ok) {
          showToast?.(result.error || 'Could not write that value.', 'error');
          await refresh();
          return false;
        }
        markSaved();
        await refresh();
        return true;
      });
    },
    [project.path, refresh, showToast, writeWithUndo, markSaved],
  );
  return { save };
}
function useVariableMove(model: VariableModel, writeWithUndo: VariableHistory) {
  const { project, showToast, refresh, fileRef, firstSelectorRef } = model;

  // Dragging a row moves the declaration inside its rule — a row in a table of
  // modes is one name in several rules, so it moves in each of them.
  // A drop is either variables moving between groups, or a heading moving
  // between variables — which is the same file in both cases, so the same undo.
  const move = useCallback(
    async (slots: readonly VariableSlot[], from: number, to: number) => {
      const plan = dropPlan(slots, from, to);
      if (!plan) {
        return;
      }
      if (plan.kind === 'rows') {
        if (!plan.moves.length) {
          return;
        }
        // Every file the plan names, not just the first: one name can be
        // declared in two stylesheets, and putting back half of a move is
        // worse than not putting it back at all.
        await writeWithUndo(
          plan.moves.map((move) => move.file),
          'the move',
          undefined,
          async () => {
            const result = await bridge('moveCssVariables', {
              projectPath: project.path,
              moves: plan.moves.map((move) => ('target' in move ? definedFields({ ...move, target: move.target ?? undefined }) : move)),
            });
            if (!result.ok) {
              showToast?.(result.error || 'Could not move that.', 'error');
            }
            await refresh();
            return result.ok;
          },
        );
        return;
      }
      const anchor = plan.block.rows.map((row) => row.cells.find(Boolean)).find(Boolean);
      const selectedFile = fileRef.current;
      assert(selectedFile !== undefined, 'Variable move: file selection is required');
      const range = headingRange(plan.block);
      if (!range) {
        showToast?.('This heading is a name prefix, not a CSS comment.', 'error');
        return;
      }
      await writeWithUndo(selectedFile.rel, 'the group', undefined, async () => {
        const result = await bridge(
          'moveCssHeading',
          definedFields({
            projectPath: project.path,
            file: selectedFile.rel,
            selector: anchor?.selector || firstSelectorRef.current,
            ...range,
            before: plan.before ?? undefined,
          }),
        );
        if (!result.ok) {
          showToast?.(result.error || 'Could not move that.', 'error');
        }
        await refresh();
        return result.ok;
      });
    },
    [project.path, refresh, showToast, writeWithUndo, fileRef, firstSelectorRef],
  );
  return { move };
}
function useVariableAdd(model: VariableModel, writeWithUndo: VariableHistory) {
  const { project, showToast, refresh } = model;

  // Adding a variable to a group. What the name is depends on the shape of the
  // group: in a family the typed word is the property (`--h1-<word>` for every
  // column), in a group named after a prefix it is what follows that prefix,
  // and in a plain list it is the whole name. In every case it lands under the
  // group's last variable rather than at the end of the rule.
  const add = useCallback(
    async (block: VariableBlock, columns: readonly WireColumn[], word: string) => {
      const typed = word.trim().replace(/^--/, '');
      if (!typed) {
        return;
      }
      const last = block.rows[block.rows.length - 1];
      const adds: Array<{
        readonly file: string;
        readonly selector: string;
        readonly name: string;
        readonly value: string;
        readonly after: string;
      }> = [];
      columns.forEach((column, index) => {
        const anchor =
          last?.cells[index] ||
          block.rows
            .map((row) => row.cells[index])
            .filter(Boolean)
            .pop();
        if (!anchor) {
          return;
        }
        const name = block.kind === 'matrix' ? `--${column.label}-${typed}` : `${stemOf(block)}${typed}`;
        adds.push({
          file: anchor.file,
          selector: anchor.selector,
          name,
          value: 'unset',
          after: anchor.name,
        });
      });
      if (!adds.length) {
        return;
      }
      await writeWithUndo(
        adds.map((added) => added.file),
        'the variable',
        undefined,
        async () => {
          const result = await bridge('addCssVariables', { projectPath: project.path, adds });
          if (!result.ok) {
            showToast?.(result.error || 'Could not add that.', 'error');
          }
          await refresh();
          return result.ok;
        },
      );
    },
    [project.path, refresh, showToast, writeWithUndo],
  );
  return { add };
}
function useVariableRename(model: VariableModel) {
  const { project, showToast, onRecordUndo, refresh } = model;

  // Renaming a variable — or a group of them, which is the same thing done to
  // every member at once. A name is not held anywhere but in the text that
  // declares and reads it, so this is one call that rewrites all of it; the
  // panel reloads from the files afterwards either way.
  const rename = useCallback(
    async (renames: readonly VariableRename[]) => {
      if (!renames?.length) {
        return true;
      }
      const result = await bridge('renameCssVariables', { projectPath: project.path, renames });
      if (!result.ok) {
        showToast?.(result.error || 'Could not rename that.', 'error');
        await refresh();
        return false;
      }
      // A rename reaches as many files as mention the name, so its inverse is
      // not a file to put back — it is the same rename read backwards.
      const back = renames.map(({ from, to }) => ({ from: to, to: from }));
      const apply = async (list: readonly VariableRename[]) => {
        const result = await bridge('renameCssVariables', {
          projectPath: project.path,
          renames: list,
        });
        if (!result.ok) {
          showToast?.(result.error || 'Could not restore the rename.', 'error');
        }
        await refresh();
      };
      onRecordUndo?.({
        label: renames.length > 1 ? 'the group rename' : 'the rename',
        undo: () => apply(back),
        redo: () => apply(renames),
      });
      await refresh();
      return true;
    },
    [project.path, refresh, showToast, onRecordUndo],
  );
  return { rename };
}
function useVariableRetitle(model: VariableModel, writeWithUndo: VariableHistory) {
  const { project, showToast, refresh, file } = model;

  // A heading that is a comment in the file rather than a name its rows share.
  // Renaming it writes those words; nothing else in the project refers to them,
  // so unlike a variable's name this reaches exactly one place.
  const retitleOnce = useCallback(
    async (block: VariableBlock, title: string) => {
      assert(file !== undefined, 'Variable heading: file selection is required');
      const range = headingRange(block);
      if (!range) {
        return false;
      }
      const result = await bridge('setCssSectionTitle', {
        projectPath: project.path,
        file: file.rel,
        ...range,
        title,
      });
      if (!result.ok) {
        showToast?.(result.error || 'Could not rename that.', 'error');
        await refresh();
        return false;
      }
      await refresh();
      return true;
    },
    [project.path, file, refresh, showToast],
  );

  const retitle = useCallback(
    async (block: VariableBlock, title: string) => {
      return writeWithUndo(file?.rel, 'the heading', undefined, () => retitleOnce(block, title));
    },
    [file?.rel, writeWithUndo, retitleOnce],
  );
  return { retitle };
}
function useVariableSections(model: VariableModel, writeWithUndo: VariableHistory) {
  const { project, showToast, refresh, firstSelectorRef, file } = model;

  // Another heading, written directly above this one — so the new group starts
  // empty, with nothing of this one's in it. Its variables are the ones you put
  // there afterwards, which is what an empty group is for.
  const duplicateSection = useCallback(
    async (block: VariableBlock) => {
      assert(file !== undefined, 'Variable heading: file selection is required');
      const anchor = block.rows.map((row) => row.cells.find(Boolean)).find(Boolean);
      await writeWithUndo(file?.rel, 'the group', undefined, async () => {
        const result = await bridge(
          'addCssSection',
          definedFields({
            projectPath: project.path,
            file: file.rel,
            selector: anchor?.selector || firstSelectorRef.current,
            title: `${block.title} copy`,
            at: block.titleStart,
          }),
        );
        if (!result.ok) {
          showToast?.(result.error || 'Could not duplicate that.', 'error');
        }
        await refresh();
        return result.ok;
      });
    },
    [project.path, file, refresh, showToast, writeWithUndo, firstSelectorRef],
  );

  // Deleting a heading deletes the comment and nothing else: its variables join
  // the group above, which is what removing a line between two runs does.
  const deleteSection = useCallback(
    async (block: VariableBlock) => {
      assert(file !== undefined, 'Variable heading: file selection is required');
      const range = headingRange(block);
      if (!range) {
        return;
      }
      await writeWithUndo(file.rel, 'deleting the group', undefined, async () => {
        const result = await bridge('removeCssSection', {
          projectPath: project.path,
          file: file.rel,
          ...range,
        });
        if (!result.ok) {
          showToast?.(result.error || 'Could not delete that.', 'error');
        }
        await refresh();
        return result.ok;
      });
    },
    [project.path, file, refresh, showToast, writeWithUndo],
  );
  return { duplicateSection, deleteSection };
}
function useVariableDrafts(model: VariableModel) {
  const { values, query, drafts, setDrafts, group } = model;

  // What the accessibility check makes of a value right now — the file's values
  // with whatever is in the fields on top.
  const fluidOf = useCallback(
    (cell: VariableCell | undefined) => {
      if (!cell) {
        return undefined;
      }
      const own = drafts[cell.name];
      const check = fluidCheck(resolveValue(own ?? cell.value, values, drafts));
      return check && check.status !== 'ok' ? check : undefined;
    },
    [values, drafts],
  );

  const noteDraft = useCallback(
    (name: string, value: string | undefined) => {
      setDrafts((current) => {
        if (value === undefined) {
          if (!(name in current)) {
            return current;
          }
          const next = { ...current };
          delete next[name];
          return next;
        }
        if (!(name in current)) {
          assert(Object.keys(current).length < LIMITS.scanEntriesMax, 'Variable drafts: limit exceeded');
        }
        return current[name] === value ? current : { ...current, [name]: value };
      });
    },
    [setDrafts],
  );

  const blocks = useMemo(() => {
    if (!group) {
      return [];
    }
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return group.blocks;
    }
    return group.blocks
      .map((block) => ({
        ...block,
        rows: block.rows.filter(
          (row) =>
            `${block.title || ''} ${row.label} ${row.name || ''}`.toLowerCase().includes(needle) ||
            row.cells.some((cell) => cell && `${cell.name} ${cell.value}`.toLowerCase().includes(needle)),
        ),
      }))
      .filter((block) => block.rows.length);
  }, [group, query]);
  return { fluidOf, noteDraft, blocks };
}
