// The files of an interrupted "Move styles", in its recovery dialog (src/app/state/styleMoveRecovery.ts). They stay folded
// under one quiet line, so the dialog is as short for a move that touched forty stylesheets as for one that touched one,
// and open in place as a list that scrolls past eight lines. The line and the list are the breakpoint usage ones
// (src/app/settings/BreakpointUsage.tsx): the same chevron, the same box, the same keyboard behaviour.
import { useId, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { ChevronRightIcon } from '../../ui/Icons';
import '../settings/breakpointsSettings.css';
import './styleMoveFiles.css';

/** One list of the fold: a heading line, then one line per project-relative path. */
export interface StyleMoveFileGroup {
  readonly label: string;
  readonly files: readonly string[];
}

/** The dialog's sentence, then the folded files under `label`; groups without files are left out. */
export function StyleMoveFiles(props: { readonly sentence: string; readonly label: string; readonly groups: readonly StyleMoveFileGroup[] }) {
  const groups = props.groups.filter((group) => group.files.length > 0);
  assert(groups.length > 0, 'StyleMoveFiles: a move names at least one file');
  assert(new Set(groups.map((group) => group.label)).size === groups.length, 'StyleMoveFiles: each group has its own heading');
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  return (
    <div className="style-move-files">
      <div>{props.sentence}</div>
      <span className="breakpoints-usage">
        <button type="button" className="breakpoints-usage-toggle" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(!expanded)}>
          {props.label}
          <ChevronRightIcon size={12} className="breakpoints-usage-chevron" />
        </button>
      </span>
      {expanded && (
        <div className="breakpoints-usage-list" id={listId}>
          <div className="breakpoints-usage-files style-move-files-rows">
            {groups.flatMap((group) => [
              <strong key={`heading:${group.label}`}>{group.label}</strong>,
              ...group.files.map((file) => <span key={`${group.label}:${file}`}>{file}</span>),
            ])}
          </div>
        </div>
      )}
    </div>
  );
}
