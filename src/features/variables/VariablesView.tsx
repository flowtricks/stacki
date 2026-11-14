import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onVariablesChanged } from '../../ipc/editorEnvironment';
import type { VariableBlock, VariableCell, VariableFile, VariableSelection } from '../../ipc/variablesBridge';
import type { WireColumn } from '../../../shared/ipc/ipcResults';
import type { VariableSlot, VariableRename } from './variableRows';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { definedFields } from '../../../shared/core/boundary';
import { variableEdit as bridge } from '../../ipc/variableEditBridge';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { useFailureText } from './useFailureText';
import { createVariableHistory, type VariableUndo } from './variableHistory';
import { createVariableRefresh } from './variableRefresh';
import { createLiveVariables, createVariableSaves, liveVariableOf, VariablePreviewContext } from './liveVariableEdits';
import { tellCanvas } from '../../editor/canvasQuery';
import { dropPlan, stemOf } from './variableRows';
import { fluidCheck, resolveValue } from './fluid';
import { getHost, setHost } from '../style/model/host';
import { CloseIcon, CheckIcon } from '../../ui/Icons';
import Sheet from './VariableTable';
import { messageRef } from '../../../shared/properties/i18n/messageRef';
import { VariableScopeBadge } from './VariableScopeBadge';
import DockableWindow, { type WindowMode } from '../../ui/DockableWindow';
import { readWindowMode, storeWindowMode } from '../../ui/windowPreferences';
import { variableCache } from './variableCache';
import { useHiddenVariables } from '../../ipc/useHiddenVariables';
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
  const translate = useTranslate();
  const model = useVariableModel(props);
  const { project, refresh, showToast, onRecordUndo } = model;
  const writeWithUndo = createVariableHistory({
    projectPath: project.path,
    refresh,
    report: (message) => showToast?.(message, 'error'),
    record: onRecordUndo,
    translate,
  });
  const save = useVariableSave(model, writeWithUndo);
  const move = useVariableMove(model, writeWithUndo);
  const add = useVariableAdd(model, writeWithUndo);
  const rename = useVariableRename(model);
  const retitle = useVariableRetitle(model, writeWithUndo);
  const sections = useVariableSections(model, writeWithUndo);
  const drafts = useVariableDrafts(model);
  const visibility = useVariableVisibility(model);
  return { ...model, ...save, ...move, ...add, ...rename, ...retitle, ...sections, ...drafts, ...visibility };
}

export default function VariablesView(props: VariablesViewProps) {
  const state = useVariablesView(props);
  const [mode, setMode] = useState(() => readWindowMode(WINDOW_MODE_KEY, { fallback: 'docked' }));
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
  const translate = useTranslate();
  const { hidden, file, group } = state;
  if (!group) {
    return undefined;
  }

  assert(file !== undefined, 'VariablesView: group must belong to a file');
  return (
    <DockableWindow
      mode={mode}
      onModeChange={onModeChange}
      label={translate('variables.title')}
      className="vars-view"
      hidden={hidden ?? false}
      minimumSize={{ width: 560, height: 280 }}
      storageKey="stacki.window.variables"
      header={<VariablesWindowHeader state={state} />}
    >
      {state.visibilityBlocked !== undefined && (
        <div className="vars-notice" role="alert">
          {translate('variables.visibility.blocked', { detail: state.visibilityBlocked })}
        </div>
      )}
      <VariablePreviewContext.Provider value={state.preview}>
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
          visibility={state.visibility}
        />
      </VariablePreviewContext.Provider>
    </DockableWindow>
  );
}

// Which variables the suggestion dropdowns leave out (`.stacki/variables.json`). The panel itself still shows them all.
// A toggle that cannot be saved (a corrupt file is never written over) reports through the toast the panel already has.
function useVariableVisibility(model: { readonly project: { readonly path: string }; readonly showToast?: VariablesViewProps['showToast'] }) {
  const translate = useTranslate();
  const { state, isHidden, hide, show } = useHiddenVariables(model.project.path);
  const { showToast } = model;
  const setHidden = useCallback(
    (name: string, change: { readonly hidden: boolean }): void => {
      void (change.hidden ? hide(name) : show(name)).then((result) => {
        if (!result.ok) {
          showToast?.(translate('variables.visibility.saveFailed', { detail: result.error.message }), 'error');
        }
      });
    },
    [hide, show, showToast, translate],
  );
  const visibility = useMemo(() => ({ isHidden, setHidden }), [isHidden, setHidden]);
  return { visibility, visibilityBlocked: state.kind === 'blocked' ? state.message : undefined };
}

function VariablesWindowHeader({ state }: { readonly state: ReturnType<typeof useVariablesView> }) {
  const translate = useTranslate();
  return (
    <>
      <div className="vars-window-heading">
        <button className="ghost cms-back" title={translate('ui.close')} onClick={state.onClose}>
          <CloseIcon size={13} />
        </button>
        <span className="cms-detail-title" title={state.group?.label}>
          {state.group?.label}
        </span>
        <VariableScopeBadge scope={state.group?.scope} />
        <span className={`cms-saved ${state.saved ? 'on' : ''}`}>
          <CheckIcon size={11} /> {translate('variables.saved')}
        </span>
      </div>
      <input
        maxLength={LIMITS.attrCharsMax}
        className="vars-search"
        value={state.query}
        placeholder={translate('variables.search')}
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
  // The panel's last read (variableCache.ts, also filled ahead by panelPrefetch.ts)
  // draws the table in the first frame; starting empty drew a blank sheet the
  // first time a group opened, and the table popped in when the read landed.
  const [snapshot, setSnapshot] = useState<{
    readonly files: readonly VariableFile[];
    readonly values: Readonly<Record<string, string>>;
  }>(() => {
    const kept = variableCache.get(projectPath);
    return kept?.kind === 'ready' ? kept.value : { files: [], values: {} };
  });
  const currentRead = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    const reader = createVariableRefresh(projectPath, (result) => {
      if (result.ok) {
        variableCache.set(projectPath, result.value);
      }
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
  const failureText = useFailureText();
  const { project, showToast, refresh, markSaved, files } = model;
  // The latest read, for the frame to find a value's declaration; read at the
  // moment of the edit, so the callbacks below need not change with every read.
  const filesRef = useRef(files);
  filesRef.current = files;

  const live = useMemo(() => createLiveVariables((message) => void tellCanvas(message)), []);
  // A page change (or the panel closing) leaves nothing to preview.
  useEffect(() => () => live.clear(), [live, project.path]);

  // One undoable write of one value. The undo step coalesces on the key, so a
  // held arrow is one step, however many writes it took.
  const writeOnce = useCallback(
    async (cell: VariableCell, value: string): Promise<boolean> => {
      return writeWithUndo(cell.file, 'variables.undo.value', `var:${cell.file}:${cell.name}`, async () => {
        const result = await bridge('setCssVariable', {
          projectPath: project.path,
          file: cell.file,
          valueStart: cell.valueStart,
          valueEnd: cell.valueEnd,
          expect: cell.value,
          value,
        });
        if (!result.ok) {
          showToast?.(failureText(result, 'variables.error.write'), 'error');
          await refresh();
          return false;
        }
        markSaved();
        await refresh();
        return true;
      });
    },
    [project.path, refresh, showToast, writeWithUndo, markSaved, failureText],
  );
  const writeRef = useRef(writeOnce);
  writeRef.current = writeOnce;

  const saves = useMemo(
    () =>
      createVariableSaves((cell, value) => writeRef.current(cell, value), {
        onStart: (cell) => live.saving(liveVariableOf(filesRef.current, cell)),
        onIdle: (cell, value) => live.saved(liveVariableOf(filesRef.current, cell), value),
      }),
    [live],
  );

  const save = useCallback(
    async (cell: VariableCell, value: string) => {
      live.saving(liveVariableOf(filesRef.current, cell));
      await saves.save(cell, value);
    },
    [live, saves],
  );
  // A field's draft, straight to the canvas; undefined when it was abandoned.
  const preview = useCallback(
    (cell: VariableCell, value: string | undefined) => {
      live.draft(liveVariableOf(filesRef.current, cell), value);
    },
    [live],
  );
  return { save, preview };
}
function useVariableMove(model: VariableModel, writeWithUndo: VariableHistory) {
  const translate = useTranslate();
  const failureText = useFailureText();
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
          'variables.undo.move',
          undefined,
          async () => {
            const result = await bridge('moveCssVariables', {
              projectPath: project.path,
              moves: plan.moves.map((move) => ('target' in move ? definedFields({ ...move, target: move.target ?? undefined }) : move)),
            });
            if (!result.ok) {
              showToast?.(failureText(result, 'variables.error.move'), 'error');
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
        showToast?.(translate('variables.error.prefixHeading'), 'error');
        return;
      }
      await writeWithUndo(selectedFile.rel, 'variables.undo.group', undefined, async () => {
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
          showToast?.(failureText(result, 'variables.error.move'), 'error');
        }
        await refresh();
        return result.ok;
      });
    },
    [project.path, refresh, showToast, writeWithUndo, fileRef, firstSelectorRef, translate, failureText],
  );
  return { move };
}
function useVariableAdd(model: VariableModel, writeWithUndo: VariableHistory) {
  const failureText = useFailureText();
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
        'variables.undo.variable',
        undefined,
        async () => {
          const result = await bridge('addCssVariables', { projectPath: project.path, adds });
          if (!result.ok) {
            showToast?.(failureText(result, 'variables.error.add'), 'error');
          }
          await refresh();
          return result.ok;
        },
      );
    },
    [project.path, refresh, showToast, writeWithUndo, failureText],
  );
  return { add };
}
function useVariableRename(model: VariableModel) {
  const translate = useTranslate();
  const failureText = useFailureText();
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
        showToast?.(failureText(result, 'variables.error.rename'), 'error');
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
          showToast?.(failureText(result, 'variables.error.restoreRename'), 'error');
        }
        await refresh();
      };
      const undoLabel = renames.length > 1 ? 'variables.undo.groupRename' : 'variables.undo.rename';
      onRecordUndo?.({
        label: translate(undoLabel),
        labelRef: messageRef(undoLabel),
        undo: () => apply(back),
        redo: () => apply(renames),
      });
      await refresh();
      return true;
    },
    [project.path, refresh, showToast, onRecordUndo, translate, failureText],
  );
  return { rename };
}
function useVariableRetitle(model: VariableModel, writeWithUndo: VariableHistory) {
  const failureText = useFailureText();
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
        showToast?.(failureText(result, 'variables.error.rename'), 'error');
        await refresh();
        return false;
      }
      await refresh();
      return true;
    },
    [project.path, file, refresh, showToast, failureText],
  );

  const retitle = useCallback(
    async (block: VariableBlock, title: string) => {
      return writeWithUndo(file?.rel, 'variables.undo.heading', undefined, () => retitleOnce(block, title));
    },
    [file?.rel, writeWithUndo, retitleOnce],
  );
  return { retitle };
}
function useVariableSections(model: VariableModel, writeWithUndo: VariableHistory) {
  const failureText = useFailureText();
  const { project, showToast, refresh, firstSelectorRef, file } = model;

  // Another heading, written directly above this one — so the new group starts
  // empty, with nothing of this one's in it. Its variables are the ones you put
  // there afterwards, which is what an empty group is for.
  const duplicateSection = useCallback(
    async (block: VariableBlock) => {
      assert(file !== undefined, 'Variable heading: file selection is required');
      const anchor = block.rows.map((row) => row.cells.find(Boolean)).find(Boolean);
      await writeWithUndo(file?.rel, 'variables.undo.group', undefined, async () => {
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
          showToast?.(failureText(result, 'variables.error.duplicate'), 'error');
        }
        await refresh();
        return result.ok;
      });
    },
    [project.path, file, refresh, showToast, writeWithUndo, firstSelectorRef, failureText],
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
      await writeWithUndo(file.rel, 'variables.undo.deleteGroup', undefined, async () => {
        const result = await bridge('removeCssSection', {
          projectPath: project.path,
          file: file.rel,
          ...range,
        });
        if (!result.ok) {
          showToast?.(failureText(result, 'variables.error.delete'), 'error');
        }
        await refresh();
        return result.ok;
      });
    },
    [project.path, file, refresh, showToast, writeWithUndo, failureText],
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
