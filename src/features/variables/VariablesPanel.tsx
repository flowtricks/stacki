import { PanelReadStatus } from '../../ui/PanelReadStatus';
import { createPanelCache, usePanelData } from '../../lib/usePanelData';
import { readCSSVariables } from './variablesBridge';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { onVariablesChanged } from '../../ipc/editorEnvironment';
import type { VariableFile, VariableGroup, VariableSelection, VariablesSnapshot } from './variablesBridge';
import { ChevronLeftIcon, ChevronRightIcon, VariableIcon, FileIcon } from '../../ui/Icons';

export interface VariablesPanelProps {
  readonly project: { readonly path: string };
  readonly selected?: VariableSelection | undefined;
  readonly onSelect: (selection: VariableSelection | undefined) => void;
}

const variableCache = createPanelCache<VariablesSnapshot>();
const EMPTY_FILES: readonly VariableFile[] = [];
// Files preserve the author's stylesheet boundaries; groups preserve the rules inside them.
export default function VariablesPanel(props: VariablesPanelProps) {
  // Project navigation starts with fresh file and default-selection state.
  return <VariableFilesPanel key={props.project.path} {...props} />;
}

function VariableFilesPanel(props: VariablesPanelProps) {
  const { selected, onSelect, project } = props;
  const { state, refresh, files } = useVariableFiles(project.path);
  const [openFile, setOpenFile] = useState<string | undefined>(undefined);
  useDefaultVariableSelection(files, selected, onSelect);
  useEffect(() => {
    if (!selected || openFile) {
      return;
    }
    const file = files.find((entry) => entry.rel === selected.file);
    if (!file || onlyGroup(file)) {
      return;
    }
    setOpenFile(selected.file);
  }, [selected, openFile, files]);
  const open = openFile ? files.find((file) => file.rel === openFile) : undefined;
  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <div className="cms-crumb">
          {open && (
            <button
              className="ghost"
              title="All stylesheets"
              onClick={() => {
                setOpenFile(undefined);
                onSelect(undefined);
              }}
            >
              <ChevronLeftIcon size={14} />
            </button>
          )}
          <h2 title={open ? open.rel : undefined}>{open ? open.name : 'Variables'}</h2>
        </div>
      </div>
      <div className="panel-body">
        {!open && files.map((file) => <VariableFileRow key={file.rel} file={file} selected={selected} onOpen={setOpenFile} onSelect={onSelect} />)}
        {open &&
          open.groups.map((group, index) => (
            <VariableGroupRow key={`${group.label}-${index}`} group={group} file={open.rel} index={index} selected={selected} onSelect={onSelect} />
          ))}
        <PanelReadStatus state={state} label="CSS variables" retry={refresh} />
        {state.kind === 'ready' && files.length === 0 && <div className="props-empty">No CSS custom properties found in this project&rsquo;s stylesheets.</div>}
      </div>
    </div>
  );
}

function useVariableFiles(projectPath: string) {
  const read = useCallback(() => readCSSVariables(projectPath), [projectPath]);
  const { state, refresh } = usePanelData(variableCache, projectPath, read, onVariablesChanged);
  const files = state.kind === 'ready' ? state.value.files.filter((file) => file.error || (file.count ?? 0) > 0) : EMPTY_FILES;
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
      <span className="cms-collection-count">{file.error ? '' : file.count === 1 ? '1 variable' : `${file.count} variables`}</span>
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
  return (
    <div
      className={`cms-collection ${selected && selected.file === file && selected.index === index ? 'on' : ''}`}
      title={group.columns.map((column) => column.selector).join(',\n')}
      onClick={() => onSelect({ file, index })}
    >
      <VariableIcon size={14} />
      <span className="cms-collection-name">{group.label}</span>
      <span className="cms-collection-count">
        {group.kind === 'modes' ? `${group.columns.length} modes` : countOf(group) === 1 ? '1 variable' : `${countOf(group)} variables`}
      </span>
      <span className="cms-collection-chevron">
        <ChevronRightIcon size={10} />
      </span>
    </div>
  );
}
function onlyGroup(file: VariableFile): boolean {
  return file.groups.length === 1;
}
function countOf(group: VariableGroup): number {
  return group.blocks.reduce((sum, block) => sum + block.rows.reduce((count, row) => count + row.cells.filter(Boolean).length, 0), 0);
}
