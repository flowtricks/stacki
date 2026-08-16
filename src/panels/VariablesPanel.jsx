import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, VariableIcon, FileIcon } from '../ui/Icons.jsx';

// The left rail's variables panel: the project's stylesheets, and what each one
// declares.
//
// A file is the top level because that is the division the author made — one
// stylesheet is the design tokens, another is the utilities — and inside it the
// groups are the rules those variables live in (see electron/cssVars.js).
export default function VariablesPanel({ project, selected, onSelect }) {
  const [files, setFiles] = useState([]);
  const [error, setError] = useState(null);
  const [openFile, setOpenFile] = useState(null);

  const refresh = useCallback(async () => {
    const result = await window.avb.cssVariables(project.path);
    setFiles(result?.files || []);
    setError(result?.error || null);
  }, [project.path]);

  useEffect(() => {
    refresh();
    return window.avb.onCssChanged(refresh);
  }, [refresh]);

  // A stylesheet with one group in it has no inside worth showing: the list of
  // groups would be a list of one, and the thing being looked for is a click
  // further on. Clicking the file opens that group and leaves the list of
  // stylesheets up, which is also what says which one is open.
  const onlyGroup = (file) => (file && file.groups?.length === 1 ? file : null);

  // Opening the panel with a group already open lands inside its file rather
  // than back at the list — unless the file is one of those, in which case the
  // list of stylesheets is where it belongs.
  useEffect(() => {
    if (!selected || openFile) return;
    const file = files.find((f) => f.rel === selected.file);
    if (!file || onlyGroup(file)) return;
    setOpenFile(selected.file);
  }, [selected, openFile, files]);

  const open = openFile ? files.find((f) => f.rel === openFile) : null;

  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <div className="cms-crumb">
          {open && (
            <button
              className="ghost"
              title="All stylesheets"
              onClick={() => {
                setOpenFile(null);
                onSelect(null);
              }}
            >
              <ChevronLeftIcon size={14} />
            </button>
          )}
          <h2 title={open ? open.rel : undefined}>{open ? open.name : 'Variables'}</h2>
        </div>
      </div>

      <div className="panel-body">
        {!open &&
          files.map((file) => (
            <div
              key={file.rel}
              className={`cms-collection ${file.error ? 'broken' : ''} ${
                onlyGroup(file) && selected?.file === file.rel ? 'on' : ''
              }`}
              title={file.rel}
              onClick={() => {
                // Opening a stylesheet opens what is in it. A list of group
                // names with an empty sheet beside it is a second click to
                // reach the thing you came for — and where there is only one
                // group, the list of names is not worth a level of its own.
                if (!file.groups?.length) return;
                if (!onlyGroup(file)) setOpenFile(file.rel);
                onSelect({ file: file.rel, index: 0 });
              }}
            >
              <FileIcon size={14} />
              <span className="cms-collection-name">{file.name}</span>
              <span className="cms-collection-count">
                {file.error ? 'unreadable' : file.count === 1 ? '1 variable' : `${file.count} variables`}
              </span>
              {/* Nothing to go into, so nothing pointing further in. */}
              {!onlyGroup(file) && (
                <span className="cms-collection-chevron">
                  <ChevronRightIcon size={10} />
                </span>
              )}
            </div>
          ))}

        {open &&
          open.groups.map((group, index) => (
            <div
              key={`${group.label}-${index}`}
              className={`cms-collection ${
                selected && selected.file === open.rel && selected.index === index ? 'on' : ''
              }`}
              title={group.columns.map((c) => c.selector).join(',\n')}
              onClick={() => onSelect({ file: open.rel, index })}
            >
              <VariableIcon size={14} />
              <span className="cms-collection-name">{group.label}</span>
              <span className="cms-collection-count">
                {group.kind === 'modes'
                  ? `${group.columns.length} modes`
                  : countOf(group) === 1
                    ? '1 variable'
                    : `${countOf(group)} variables`}
              </span>
              <span className="cms-collection-chevron">
                <ChevronRightIcon size={10} />
              </span>
            </div>
          ))}

        {error && <div className="cms-error">{error}</div>}
        {!files.length && !error && (
          <div className="props-empty">
            No CSS custom properties found in this project&rsquo;s stylesheets.
          </div>
        )}
      </div>
    </div>
  );
}

const countOf = (group) =>
  group.blocks.reduce(
    (sum, block) => sum + block.rows.reduce((n, row) => n + row.cells.filter(Boolean).length, 0),
    0
  );
