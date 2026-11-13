import { useFormat, useTranslate } from '../../lib/i18n/useTranslate';
import { PanelReadStatus } from '../../ui/PanelReadStatus';
import { ErrorToast } from '../../ui/ErrorToast';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { MessageRef } from '../../../shared/core/i18n/messageReference';
import { translateReference } from '../../lib/i18n/translateErrorText';
import type { HistoryCommit, HistoryCommitFile } from './historyBridge';
import { readHistoryLog } from './historyBridge';
import { commitAuthor, relativeTime } from './historyModel';
import { BranchIcon, PreviewIcon } from '../../ui/Icons';
import HistoryCommitFiles from './HistoryCommitFiles';
import CommitAvatar from './CommitAvatar';
import { useCommitAvatars } from './commitAvatars';
import { createCoalescedRun } from '../../lib/coalescedRun';
import { onWindowReturn } from '../../lib/windowReturn';
import MoreMenu from '../../ui/MoreMenu';
import Dropdown from '../../ui/Dropdown';
import Tooltip from '../../ui/Tooltip';
import HistoryGraphLane, { HISTORY_ROW_HEIGHT, historyGraphWidth } from './HistoryGraphLane';
import { buildHistoryGraph, HISTORY_COMMITS_MAX } from './historyGraph';
import type { HistoryGraphRow } from './historyGraph';
import { gitBranchColors, gitBranchColor, gitRefColor } from '../../lib/gitBranchColors';
import { timelineCache, timelineKey } from './timelineCache';

function initialTimeline(key: string): TimelineState {
  const cached = timelineCache.get(key);
  return cached?.kind === 'ready' ? { kind: 'ready', ...cached.value } : { kind: 'loading', commits: [], atEnd: false };
}

type TimelineState =
  | {
      readonly kind: 'loading';
      readonly commits: readonly HistoryCommit[];
      readonly atEnd: boolean;
    }
  | { readonly kind: 'ready'; readonly commits: readonly HistoryCommit[]; readonly atEnd: boolean }
  | {
      readonly kind: 'error';
      readonly commits: readonly HistoryCommit[];
      readonly atEnd: boolean;
      readonly message: string;
      readonly messageRef?: MessageRef | undefined;
    };

interface HistoryTimelineProps {
  readonly projectPath: string;
  readonly branch: string | undefined;
  readonly trunk?: string;
  readonly branches?: readonly string[];
  readonly head: string | undefined;
  readonly userEmail: string | undefined;
  readonly previewRef: string | undefined;
  readonly onPreviewCommit?: ((commit: HistoryCommit) => void) | undefined;
  readonly onExitPreview: () => void;
  readonly onRestoreFile?: ((commit: HistoryCommit, file: HistoryCommitFile) => void) | undefined;
  readonly onRestoreProject?: ((commit: HistoryCommit) => void) | undefined;
}

export default function HistoryTimeline(props: HistoryTimelineProps) {
  const translate = useTranslate();
  const [scope, setScope] = useState<'all' | 'current'>('all');
  const reference = scope === 'current' ? 'HEAD' : undefined;
  const timeline = useTimeline(props, reference);
  const colors = useMemo(
    () =>
      gitBranchColors(
        props.branches ?? [],
        props.trunk ?? 'main',
        timeline.state.commits.flatMap((commit) => commit.refs),
      ),
    [props.branches, props.trunk, timeline.state.commits],
  );
  const graph = useMemo(() => buildHistoryGraph(timeline.state.commits, props.trunk ?? 'main', colors), [timeline.state.commits, props.trunk, colors]);
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  // Pictures arrive in the background; rows render with initials until then.
  const avatars = useCommitAvatars(props.projectPath, timeline.state.commits);
  useEffect(() => {
    setExpanded((hash) => (hash && timeline.state.commits.some((commit) => commit.hash === hash) ? hash : undefined));
  }, [timeline.state.commits]);
  return (
    <>
      <HistoryScope scope={scope} branch={props.branch} setScope={setScope} />
      {timeline.state.kind === 'error' && <ErrorToast message={translateReference(timeline.state.message, timeline.state.messageRef, translate)} />}
      {timeline.state.kind === 'ready' && timeline.state.commits.length === 0 && <p className="history-empty">{translate('history.timeline.empty')}</p>}
      {graph.rows.map((row) => (
        <CommitRow
          key={row.commit.hash}
          commit={row.commit}
          row={row}
          colors={colors}
          width={graph.width}
          avatar={avatars.get(row.commit.hash)}
          expanded={expanded === row.commit.hash}
          previewing={props.previewRef === row.commit.hash}
          toggle={() => setExpanded(expanded === row.commit.hash ? undefined : row.commit.hash)}
          {...props}
        />
      ))}
      {timeline.state.kind === 'loading' && (
        <PanelReadStatus state={timeline.state} label={translate('history.timeline.label')} layout="history" retry={async () => {}} />
      )}
      {!timeline.state.atEnd && timeline.state.kind !== 'loading' && (
        <button className="history-more" onClick={timeline.loadOlder}>
          {translate('history.timeline.showOlder')}
        </button>
      )}
    </>
  );
}

function HistoryScope({
  scope,
  branch,
  setScope,
}: {
  readonly scope: 'all' | 'current';
  readonly branch: string | undefined;
  readonly setScope: (scope: 'all' | 'current') => void;
}) {
  const translate = useTranslate();
  return (
    <div className="history-graph-toolbar">
      {/* The branch name stays out of the label, where the narrow menu would cut it
          off, and is named in the tooltip instead. */}
      <div className="history-graph-filter" title={scope === 'current' ? translate('history.scope.showing', { branch: branch ?? 'HEAD' }) : undefined}>
        <span>{translate('history.scope.label')}</span>
        {/* The app's own menu rather than a native select, so it looks and behaves
            like every other menu: a check at the row's end and no hover preview. */}
        <Dropdown<HistoryScopeName>
          ariaLabel={translate('history.scope.ariaLabel')}
          value={scope}
          options={[
            { value: 'all', label: translate('history.scope.all') },
            { value: 'current', label: translate('history.scope.current') },
          ]}
          livePreview={false}
          onChange={(value) => setScope(parseHistoryScope(value))}
        />
      </div>
    </div>
  );
}

type HistoryScopeName = 'all' | 'current';

function parseHistoryScope(value: string): HistoryScopeName {
  if (value === 'all') {
    return value;
  }
  assert(value === 'current', 'History graph: unknown branch scope');
  return value;
}

function useTimeline({ projectPath, branch, head }: HistoryTimelineProps, reference: string | undefined) {
  const key = timelineKey(projectPath, branch, head, reference);
  const [state, setState] = useState<TimelineState>(() => initialTimeline(key));
  const requestRef = useRef(0);
  useEffect(() => {
    let closed = false;
    setState(initialTimeline(key));
    const reader = createCoalescedRun(async () => {
      if (closed) {
        return;
      }
      const request = ++requestRef.current;
      const result = await readHistoryLog(projectPath, 0, reference);
      if (closed || requestRef.current !== request) {
        return;
      }
      if (result.ok) {
        timelineCache.set(key, result.value);
      }
      setState((previous) => {
        if (!result.ok) {
          return { ...previous, kind: 'error', message: result.error, messageRef: result.errorRef };
        }
        // Keep expanded rows and older pages when the newest commits have not changed.
        const prefix = previous.commits.slice(0, result.value.commits.length);
        if (
          previous.kind === 'ready' &&
          (!result.value.atEnd || previous.commits.length === result.value.commits.length) &&
          JSON.stringify(prefix) === JSON.stringify(result.value.commits)
        ) {
          return previous;
        }
        return { kind: 'ready', commits: result.value.commits, atEnd: result.value.atEnd };
      });
    });
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        void reader.request();
      }
    };
    void reader.request();
    // Git refs can move without a source-file event, including commits on other branches.
    const timer = window.setInterval(refresh, 15_000);
    const offReturn = onWindowReturn(refresh);
    return () => {
      closed = true;
      requestRef.current += 1;
      window.clearInterval(timer);
      offReturn();
    };
  }, [branch, head, projectPath, reference, key]);
  const loadOlder = useCallback(() => {
    if (state.kind === 'loading' || state.commits.length >= HISTORY_COMMITS_MAX) {
      return;
    }
    void appendHistory({ projectPath, reference }, state, requestRef, setState);
  }, [projectPath, reference, state]);
  return { state, loadOlder };
}

async function appendHistory(
  location: { readonly projectPath: string; readonly reference: string | undefined },
  previous: TimelineState,
  requestRef: React.MutableRefObject<number>,
  setState: React.Dispatch<React.SetStateAction<TimelineState>>,
): Promise<void> {
  const request = ++requestRef.current;
  setState({ kind: 'loading', commits: previous.commits, atEnd: previous.atEnd });
  const result = await readHistoryLog(location.projectPath, previous.commits.length, location.reference);
  if (requestRef.current !== request) {
    return;
  }
  if (!result.ok) {
    setState({ kind: 'error', commits: previous.commits, atEnd: false, message: result.error, messageRef: result.errorRef });
    return;
  }
  const commits = mergeCommits(previous.commits, result.value.commits);
  setState({
    kind: 'ready',
    commits,
    atEnd: result.value.atEnd || commits.length >= HISTORY_COMMITS_MAX,
  });
}

function mergeCommits(previous: readonly HistoryCommit[], incoming: readonly HistoryCommit[]): readonly HistoryCommit[] {
  const commits = new Map(previous.map((commit) => [commit.hash, commit]));
  for (const commit of incoming) {
    if (commits.size >= HISTORY_COMMITS_MAX) {
      break;
    }
    commits.set(commit.hash, commit);
  }
  assert(commits.size <= HISTORY_COMMITS_MAX, 'History timeline: commit limit exceeded');
  return [...commits.values()];
}

interface CommitRowProps extends HistoryTimelineProps {
  readonly colors: ReadonlyMap<string, number>;
  readonly commit: HistoryCommit;
  readonly row: HistoryGraphRow;
  readonly avatar: string | undefined;
  readonly width: number;
  readonly expanded: boolean;
  readonly previewing: boolean;
  readonly toggle: () => void;
}

function CommitRow(props: CommitRowProps) {
  const { commit } = props;
  const translate = useTranslate();
  const format = useFormat();
  return (
    <div
      className={`history-commit ${props.expanded ? 'open' : ''} ${props.previewing ? 'previewing' : ''}`}
      style={{ gridTemplateColumns: `${historyGraphWidth(props.width)}px minmax(140px, 1fr)` }}
    >
      <HistoryGraphLane row={props.row} width={props.width} current={commit.hash === props.head} />
      <button className="history-commit-head" style={{ height: HISTORY_ROW_HEIGHT }} onClick={props.toggle} aria-expanded={props.expanded}>
        <span className="history-commit-main">
          <span className="history-subject-line">
            <CommitRefs commit={commit} current={commit.hash === props.head} colors={props.colors} />
            <Tooltip className="history-subject" text={commit.subject} />
          </span>
          <span className="history-meta">
            {/* At the start of the meta line, not in the lane, so the graph and HEAD marker stay clear. */}
            <CommitAvatar name={commit.author} email={commit.email} url={props.avatar} />
            {/* The text is its own box: a flex row cannot ellipsize bare text. */}
            <span className="history-meta-text">
              {commitAuthor(commit, props.userEmail, translate)} · {relativeTime(commit.when, Date.now(), { translate, format })} ·{' '}
              <span className="history-row-hash" title={commit.hash}>
                {commit.shortHash}
              </span>
            </span>
          </span>
        </span>
      </button>
      {props.expanded && <CommitBody {...props} />}
    </div>
  );
}

function CommitRefs({ commit, current, colors }: { readonly commit: HistoryCommit; readonly current: boolean; readonly colors: ReadonlyMap<string, number> }) {
  if (commit.refs.length === 0) {
    if (!current) {
      return undefined;
    }
  }
  return (
    <span className="history-refs">
      {current && <span className="history-ref current">HEAD</span>}
      {commit.refs
        .filter((reference) => reference !== 'HEAD')
        .map((reference) => {
          const color = gitRefColor(reference, colors);
          return (
            <span
              className={`history-ref ${color === undefined ? '' : 'history-ref-branch'}
                history-ref-branch-${color ?? 'tag'}`}
              style={color === undefined ? undefined : { color: gitBranchColor(color) }}
              key={reference}
              title={reference}
            >
              {reference.startsWith('tag: ') ? undefined : <BranchIcon size={10} />}
              {reference.replace(/^HEAD -> /, '')}
            </span>
          );
        })}
    </span>
  );
}

function CommitBody(props: CommitRowProps) {
  const { commit } = props;
  const translate = useTranslate();
  return (
    <div className="history-commit-body">
      <HistoryCommitFiles commit={commit} projectPath={props.projectPath} onRestoreFile={props.onRestoreFile} />
      <div className="history-commit-actions">
        {props.onPreviewCommit && (
          <button
            className={`history-preview-action ${props.previewing ? 'primary' : 'ghost'}`}
            onClick={() => (props.previewing ? props.onExitPreview() : props.onPreviewCommit?.(commit))}
          >
            <PreviewIcon size={12} />
            {props.previewing ? translate('history.backToNow') : translate('history.commit.preview')}
          </button>
        )}
        <span className="history-hash">{commit.isMerge ? translate('history.commit.merge') : commit.shortHash}</span>
        {props.onRestoreProject && (
          <MoreMenu
            title={translate('history.commit.actions')}
            width={230}
            items={[
              {
                label: translate('history.commit.restoreProject'),
                onSelect: () => props.onRestoreProject?.(commit),
              },
            ]}
          />
        )}
      </div>
    </div>
  );
}
