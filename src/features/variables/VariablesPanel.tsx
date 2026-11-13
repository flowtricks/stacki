import { useTranslate } from '../../lib/i18n/useTranslate';
import { PanelReadStatus } from '../../ui/PanelReadStatus';
import { usePanelData } from '../../lib/usePanelData';
import { variableCache } from './variableCache';
import { readCSSVariables } from '../../ipc/variablesBridge';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onVariablesChanged } from '../../ipc/editorEnvironment';
import type { VariableFile, VariableGroup, VariableSelection } from '../../ipc/variablesBridge';
import { ChevronLeftIcon, ChevronRightIcon, VariableIcon, FileIcon } from '../../ui/Icons';
import { VariableScopeBadge } from './VariableScopeBadge';
import { variableFileListed, type VariablePlace } from '../../editor/variablePlace';
import { assert } from '../../../shared/core/assert';

export interface VariablesPanelProps {
  readonly project: { readonly path: string };
  /** Where the user is: a page's or a component's own variables are listed only while it is open (variablePlace.ts). */
  readonly place: VariablePlace;
  readonly selected?: VariableSelection | undefined;
  readonly onSelect: (selection: VariableSelection | undefined) => void;
}

const EMPTY_FILES: readonly VariableFile[] = [];
// Files preserve the author's stylesheet boundaries; groups preserve the rules inside them.
export default function VariablesPanel(props: VariablesPanelProps) {
  // Project navigation starts with fresh file and default-selection state.
  return <VariableFilesPanel key={props.project.path} {...props} />;
}

function VariableFilesPanel(props: VariablesPanelProps) {
  const translate = useTranslate();
  const { selected, onSelect, project, place } = props;
  const { state, refresh, files } = useVariableFiles(project.path, place);
  // The first frame opens the file the selection (or the default one) is in: opening
  // it from an effect drew the file list for a frame and then swapped in the
  // file's groups, on every open of the panel.
  const [openFile, setOpenFile] = useState<string | undefined>(() => fileToOpen(files, selected));
  useDefaultVariableSelection(files, selected, onSelect);
  useEffect(() => {
    if (openFile) {
      return;
    }
    // Files that arrive after the first frame (nothing was cached) open the same way.
    if (selected) {
      const rel = fileToOpen(files, selected);
      if (rel !== undefined) {
        setOpenFile(rel);
      }
    }
  }, [selected, openFile, files]);
  const open = openFile ? files.find((file) => file.rel === openFile) : undefined;
  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <div className="cms-crumb">
          {open && (
            <button
              className="ghost"
              title={translate('variables.panel.allFiles')}
              onClick={() => {
                setOpenFile(undefined);
                onSelect(undefined);
              }}
            >
              <ChevronLeftIcon size={14} />
            </button>
          )}
          <h2 title={open ? open.rel : undefined}>{open ? open.name : translate('variables.title')}</h2>
        </div>
      </div>
      <div className="panel-body">
        {!open && files.map((file) => <VariableFileRow key={file.rel} file={file} selected={selected} onOpen={setOpenFile} onSelect={onSelect} />)}
        {open &&
          open.groups.map((group, index) => (
            <VariableGroupRow key={`${group.label}-${index}`} group={group} file={open.rel} index={index} selected={selected} onSelect={onSelect} />
          ))}
        <PanelReadStatus state={state} label={translate('variables.panel.cssVariables')} retry={refresh} />
        {state.kind === 'ready' && files.length === 0 && <div className="props-empty">{translate('variables.panel.empty', { tag: '<style>' })}</div>}
      </div>
    </div>
  );
}

// The list follows the open file, never the selection: selecting on the canvas
// while the panel is open must not add and drop rows under the pointer.
function useVariableFiles(projectPath: string, place: VariablePlace) {
  const read = useCallback(() => readCSSVariables(projectPath), [projectPath]);
  const { state, refresh } = usePanelData(variableCache, projectPath, read, onVariablesChanged);
  const { openFile, contextPage } = place;
  const files = useMemo(() => {
    if (state.kind !== 'ready') {
      return EMPTY_FILES;
    }
    const here = { openFile, contextPage };
    return state.value.files.filter((file) => (file.error || (file.count ?? 0) > 0) && variableFileListed(file.rel, here));
  }, [state, openFile, contextPage]);
  return { state, refresh, files };
}

function useDefaultVariableSelection(files: readonly VariableFile[], selected: VariableSelection | undefined, onSelect: VariablesPanelProps['onSelect']): void {
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) {
      return;
    }
    if (files.length === 0) {
      return;
    }
    // Default once on entry so refreshes cannot undo a deliberate back navigation.
    initialized.current = true;
    if (selected !== undefined) {
      return;
    }
    if (files.length === 1) {
      const file = files[0];
      if (file?.groups.length) {
        onSelect({ file: file.rel, index: 0 });
      }
    }
  }, [files, selected, onSelect]);
}

interface FileRowProps {
  readonly file: VariableFile;
  readonly selected: VariableSelection | undefined;
  readonly onOpen: (file: string) => void;
  readonly onSelect: VariablesPanelProps['onSelect'];
}
function VariableFileRow({ file, selected, onOpen, onSelect }: FileRowProps) {
  const translate = useTranslate();
  return (
    <div
      className={`cms-collection ${file.error ? 'broken' : ''} ${onlyGroup(file) && selected?.file === file.rel ? 'on' : ''}`}
      title={file.rel}
      onClick={() => {
        if (!file.groups.length) {
          return;
        }
        if (!onlyGroup(file)) {
          onOpen(file.rel);
        }
        onSelect({ file: file.rel, index: 0 });
      }}
    >
      <FileIcon size={14} />
      <span className="cms-collection-name">{file.name}</span>
      {onlyGroup(file) && <VariableScopeBadge scope={file.groups[0]?.scope} />}
      <span className="cms-collection-count">{file.error ? '' : translate('variables.count', { count: file.count ?? 0 })}</span>
      {!onlyGroup(file) && (
        <span className="cms-collection-chevron">
          <ChevronRightIcon size={10} />
        </span>
      )}
    </div>
  );
}
interface GroupRowProps {
  readonly group: VariableGroup;
  readonly file: string;
  readonly index: number;
  readonly selected: VariableSelection | undefined;
  readonly onSelect: VariablesPanelProps['onSelect'];
}
function VariableGroupRow({ group, file, index, selected, onSelect }: GroupRowProps) {
  const translate = useTranslate();
  return (
    <div
      className={`cms-collection ${selected && selected.file === file && selected.index === index ? 'on' : ''}`}
      title={group.columns.map((column) => column.selector).join(',\n')}
      onClick={() => onSelect({ file, index })}
    >
      <VariableIcon size={14} />
      <span className="cms-collection-name">{group.label}</span>
      <VariableScopeBadge scope={group.scope} />
      <span className="cms-collection-count">
        {group.kind === 'modes' ? translate('variables.modes', { count: group.columns.length }) : translate('variables.count', { count: countOf(group) })}
      </span>
      <span className="cms-collection-chevron">
        <ChevronRightIcon size={10} />
      </span>
    </div>
  );
}
/**
 * The file whose groups the panel opens on: the selection's, or with nothing
 * selected the project's only file (useDefaultVariableSelection selects its first
 * group). A file with one group is never opened: its row is the group.
 */
export function fileToOpen(files: readonly VariableFile[], selected: VariableSelection | undefined): string | undefined {
  const file = selected === undefined ? (files.length === 1 ? files[0] : undefined) : files.find((entry) => entry.rel === selected.file);
  if (file === undefined) {
    return undefined;
  }
  if (file.groups.length > 1) {
    return file.rel;
  }
  assert(onlyGroup(file) || file.groups.length === 0, 'fileToOpen: a file not opened has at most one group');
  return undefined;
}
function onlyGroup(file: VariableFile): boolean {
  return file.groups.length === 1;
}
function countOf(group: VariableGroup): number {
  return group.blocks.reduce((sum, block) => sum + block.rows.reduce((count, row) => count + row.cells.filter(Boolean).length, 0), 0);
}
