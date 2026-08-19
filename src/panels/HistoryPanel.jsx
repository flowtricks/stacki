import React, { useCallback, useEffect, useState } from 'react';
import FileBrowser from '../ui/FileBrowser.jsx';
import FileStatus from '../ui/FileStatus.jsx';
import BranchActions from '../ui/BranchActions.jsx';
import {
  BranchIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  MergeIcon,
  PreviewIcon,
  TrashIcon,
} from '../ui/Icons.jsx';

// The project's history: what happened, on which branch, and in which
// checkout.
//
// The panel is written for someone who has never used git and needs to answer
// one question — "what did this look like before?" — without being asked to
// learn a vocabulary first. So a commit is a row that says what changed in the
// project's own words ("You changed Home and 2 other pages"), not a hash and a
// subject line. The hash is there, small, for the person who does want it:
// hiding it would make the panel useless to a developer, and leading with it
// would make it useless to everybody else.
//
// Three sections because there are three questions. Timeline is "when";
// Branches is "which version of the project"; Worktrees is "where on disk" —
// the last only appearing when there is more than one, since a project with a
// single checkout has no question to answer there.

const PAGE = 30;

// --- Saying when ------------------------------------------------------------
// Times are relative near the present and absolute past it, because "3 weeks
// ago" stops being something you can place and a date starts being one.
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const secs = Math.round((now - t) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// The heading a commit sits under. Days near the present are named rather than
// dated for the same reason.
export function dayGroup(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const startOf = (ms) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((startOf(now) - startOf(t)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// --- Saying what changed ----------------------------------------------------
// A commit touching six files is not six facts. The first one or two are named
// and the rest are counted, because the point of the line is to be recognised
// at a glance — "that's the one where I did the hero" — not to be complete.
// The full list is one click away.
export function summarize(files) {
  if (!files || !files.length) return 'No files changed';
  const labels = [...new Set(files.map((f) => f.label))];
  const pages = files.filter((f) => f.kind === 'page').length;
  // What to call them: if it's all pages, say pages. Mixed, say files.
  const noun = pages === files.length ? 'page' : 'file';
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  // Three distinct names or more, so the remainder is always at least two and
  // the plural is not a case that needs deciding.
  return `${labels[0]} and ${labels.length - 1} other ${noun}s`;
}

// Git records an author on every commit; on your own machine that is almost
// always you, and "Timothy Ricks changed the hero" reads oddly about yourself.
const who = (commit, me) => (me && commit.email === me ? 'You' : commit.author);

function Section({ title, count, open, onToggle, children }) {
  return (
    <div className={`history-section ${open ? 'open' : ''}`}>
      <button className="history-section-head" onClick={onToggle}>
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        <span className="history-section-title">{title}</span>
        {count != null && <span className="history-section-count">{count}</span>}
      </button>
      {open && children}
    </div>
  );
}

export default function HistoryPanel({
  project,
  gitInfo,
  onRefreshGit,
  previewRef,
  onPreviewCommit,
  onExitPreview,
  onRestoreFile,
  onRestoreProject,
  onOpenFile,
  onSwitchBranch,
  onMergeBranch,
  onDeleteBranch,
  showToast,
}) {
  const [commits, setCommits] = useState([]);
  const [atEnd, setAtEnd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null); // hash of the open commit
  const [worktrees, setWorktrees] = useState([]);
  const [allFiles, setAllFiles] = useState([]);
  const [open, setOpen] = useState({ timeline: true, files: false, branches: false, worktrees: false });

  const branch = gitInfo?.branch;

  const load = useCallback(
    async (append = false) => {
      if (!project) return;
      setError(null);
      try {
        const skip = append ? commits.length : 0;
        const r = await window.avb.gitLog({
          projectPath: project.path,
          limit: PAGE,
          skip,
          withFiles: true,
        });
        setCommits((prev) => (append ? [...prev, ...(r?.commits || [])] : r?.commits || []));
        setAtEnd(!!r?.atEnd);
      } catch (err) {
        setError(String(err?.message || err));
      } finally {
        setLoading(false);
      }
    },
    [project, commits.length]
  );

  // Reloaded when the branch changes or a commit lands: both rewrite what the
  // timeline should be showing, and neither is something this panel does
  // itself — the chip in the title bar does most of it.
  useEffect(() => {
    setLoading(true);
    setCommits([]);
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.path, branch, gitInfo?.head]);

  // The whole project, with what has happened to each file. Read when the
  // section is opened and again whenever anything lands, so it says what is
  // true now rather than what was true when the panel was first shown.
  useEffect(() => {
    if (!project || !open.files) return;
    window.avb
      .gitAllFiles({ projectPath: project.path })
      .then((f) => setAllFiles(f || []))
      .catch(() => setAllFiles([]));
  }, [project, open.files, branch, gitInfo?.head, gitInfo?.dirty]);

  useEffect(() => {
    if (!project || !open.worktrees) return;
    window.avb
      .gitWorktrees({ projectPath: project.path })
      .then((w) => setWorktrees(w || []))
      .catch(() => setWorktrees([]));
  }, [project, open.worktrees, branch]);

  const toggle = (id) => setOpen((o) => ({ ...o, [id]: !o[id] }));

  if (!project) return null;
  if (gitInfo && !gitInfo.isRepo) {
    return (
      <div className="panel-section grow">
        <div className="panel-header">
          <h2>History</h2>
        </div>
        <div className="panel-body">
          <p className="history-empty">
            This project isn’t tracking its history yet. Turn it on from the branch button in
            the title bar and every save from then on can be gone back to.
          </p>
        </div>
      </div>
    );
  }

  const me = gitInfo?.userEmail;
  let lastDay = null;

  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <h2>History</h2>
      </div>

      <div className="panel-body history-body">
        {previewRef && (
          // The panel is the way out of a preview as well as the way in, since
          // it is where you were when you started one.
          <button className="history-exit-preview" onClick={onExitPreview}>
            Back to now
          </button>
        )}

        <Section title="Timeline" open={open.timeline} onToggle={() => toggle('timeline')}>
          {loading && <p className="history-empty">Reading history…</p>}
          {error && <p className="history-error">{error}</p>}
          {!loading && !error && !commits.length && (
            <p className="history-empty">
              Nothing saved yet. Once you save your first version it shows up here, and you
              can come back to it whenever you like.
            </p>
          )}

          {commits.map((c) => {
            const day = dayGroup(c.when);
            const newDay = day !== lastDay;
            lastDay = day;
            const isOpen = expanded === c.hash;
            const isPreviewing = previewRef === c.hash;
            return (
              <React.Fragment key={c.hash}>
                {newDay && <div className="history-day">{day}</div>}
                <div
                  className={`history-commit ${isOpen ? 'open' : ''} ${isPreviewing ? 'previewing' : ''}`}
                >
                  <button
                    className="history-commit-head"
                    onClick={() => setExpanded(isOpen ? null : c.hash)}
                  >
                    <span className="history-dot" />
                    <span className="history-commit-main">
                      <span className="history-subject">{c.subject}</span>
                      <span className="history-meta">
                        {who(c, me)} · {summarize(c.files)} · {relativeTime(c.when)}
                      </span>
                    </span>
                  </button>

                  {isOpen && (
                    <div className="history-commit-body">
                      <div className="history-files">
                        {(c.files || []).map((f) => (
                          <div className="history-file" key={f.path + (f.from || '')}>
                            <FileStatus status={f.status} inCommit />
                            <span className="history-file-label" title={f.path}>
                              {f.label}
                            </span>
                            <button
                              className="row-action"
                              title={`Put ${f.label} back to how it was here`}
                              onClick={() => onRestoreFile?.(c, f)}
                            >
                              <ChevronRightIcon size={12} />
                            </button>
                          </div>
                        ))}
                        {!c.files?.length && (
                          <div className="history-file muted">Nothing changed in this one</div>
                        )}
                      </div>
                      <div className="history-commit-actions">
                        <button
                          className={isPreviewing ? 'primary' : ''}
                          onClick={() => (isPreviewing ? onExitPreview?.() : onPreviewCommit?.(c))}
                        >
                          <PreviewIcon size={12} />
                          {isPreviewing ? 'Back to now' : 'Preview this version'}
                        </button>
                        <button onClick={() => onRestoreProject?.(c)}>Take everything back to here</button>
                      </div>
                      <div className="history-hash" title="What git calls this version">
                        {c.shortHash}
                        {c.isMerge ? ' · brought a branch in' : ''}
                      </div>
                    </div>
                  )}
                </div>
              </React.Fragment>
            );
          })}

          {!atEnd && !loading && commits.length > 0 && (
            <button className="history-more" onClick={() => load(true)}>
              Show older
            </button>
          )}
        </Section>

        {/* What the project is made of, and which parts of it have changed.
            The same browser the commit picker uses — there it ticks files, here
            it is a list to look at and open. */}
        <Section
          title="Files"
          count={allFiles.filter((f) => f.status).length || null}
          open={open.files}
          onToggle={() => toggle('files')}
        >
          <FileBrowser
            files={allFiles}
            onOpen={(f) => onOpenFile?.(f)}
            emptyMessage="Nothing here yet."
          />
        </Section>

        <Section
          title="Branches"
          count={gitInfo?.branches?.length}
          open={open.branches}
          onToggle={() => toggle('branches')}
        >
          {(gitInfo?.branches || []).map((b) => (
            <div
              key={b}
              className={`list-item ${b === branch ? 'active' : ''}`}
              onClick={() => b !== branch && onSwitchBranch?.(b)}
            >
              <span className="icon" style={{ width: 14 }}>
                {b === branch ? <CheckIcon size={12} /> : <BranchIcon size={12} />}
              </span>
              <span className="label">{b}</span>
              {(gitInfo?.parked || []).includes(b) && b !== branch && (
                <span className="branch-parked" title="Changes waiting on this branch">
                  changes waiting
                </span>
              )}
              <BranchActions
                branch={b}
                current={branch}
                trunk={gitInfo?.trunk}
                onMerge={onMergeBranch}
                onDelete={onDeleteBranch}
              />
            </div>
          ))}
        </Section>

        <Section
          title="Worktrees"
          count={worktrees.length > 1 ? worktrees.length : null}
          open={open.worktrees}
          onToggle={() => toggle('worktrees')}
        >
          {/* A project with one checkout still gets the section, because
              opening it is what goes and looks — a count on a closed section
              would have to fetch for every project whether or not anyone asked.
              What differs is only what it says once open. */}
          <p className="history-note">
            {worktrees.length > 1
              ? 'The same project, open in more than one folder — each on its own branch.'
              : 'This project is open in one folder only. Worktrees let the same project sit in several folders at once, each on a different branch.'}
          </p>
          {worktrees.length > 1 &&
            worktrees.map((w) => (
              <div className="list-item" key={w.path} title={w.path}>
                <span className="icon" style={{ width: 14 }}>
                  <BranchIcon size={12} />
                </span>
                <span className="label">{w.branch || 'a single version'}</span>
                <span className="sub">{w.path.split('/').slice(-1)[0]}</span>
              </div>
            ))}
        </Section>
      </div>
    </div>
  );
}
