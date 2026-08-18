import React, { useEffect, useRef, useState } from 'react';
import { cleanError } from '../App.jsx';
import { LayersIcon, CloseIcon } from '../ui/Icons.jsx';
import StackiLogo from '../ui/StackiLogo.jsx';
import WelcomeBackground from '../ui/WelcomeBackground.jsx';

export default function WelcomeScreen({ onOpen, setBusy, showToast }) {
  const [error, setError] = useState(null);
  const [recents, setRecents] = useState([]);
  const [newProjectDir, setNewProjectDir] = useState(null);
  // Where a site started from a template should go, once the folder is chosen.
  const [starterDir, setStarterDir] = useState(null);
  // Which cards are having their picture retaken. Nothing is announced about
  // it: a thumbnail being out of date is the app's problem, not something to
  // put a badge on and ask the user to deal with.
  const [refreshing, setRefreshing] = useState({});

  useEffect(() => {
    window.avb
      .listRecents()
      .then((list) => setRecents(list || []))
      .catch(() => {});
  }, []);

  // A card whose site has changed since its picture was taken quietly gets a
  // new one: the home page is rendered off screen and the image swaps in when
  // it is ready (see electron/thumbs.js). One project at a time, in the order
  // they are shown, and it stops the moment this screen goes away — opening a
  // project should not be competing with a screenshot for the same machine.
  useEffect(() => {
    const stale = recents.filter((r) => r.canRefresh && (r.stale || !r.thumb));
    if (!stale.length) return undefined;
    let live = true;
    (async () => {
      for (const project of stale) {
        if (!live) return;
        setRefreshing((r) => ({ ...r, [project.path]: true }));
        try {
          const result = await window.avb.refreshThumb(project.path);
          if (live && result?.thumb) {
            setRecents((prev) =>
              prev.map((p) =>
                p.path === project.path ? { ...p, thumb: result.thumb, stale: !!result.stale } : p
              )
            );
          }
        } catch {
          // A project that will not render keeps the picture it had. There is
          // nothing here the user asked for, so there is nothing to report.
        } finally {
          if (live) setRefreshing((r) => ({ ...r, [project.path]: false }));
        }
      }
    })();
    return () => {
      live = false;
    };
    // Runs when the list first arrives, not on every image that swaps in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recents.length]);

  const openExisting = async () => {
    setError(null);
    const result = await window.avb.openProjectDialog();
    if (result.canceled) return;
    if (result.error) {
      setError(result.error);
      return;
    }
    onOpen(result.projectPath);
  };

  // Pick the folder first, then collect the same answers `npm create
  // astro@latest` would ask for in the terminal; the wizard runs the real CLI.
  const createNew = async () => {
    setError(null);
    const result = await window.avb.newProjectDialog();
    if (result.canceled) return;
    if (result.error) {
      setError(result.error);
      return;
    }
    setNewProjectDir(result.projectPath);
  };

  // A site built on Lumos: the framework's own scaffolder, run in a folder of
  // their choosing under a name of their choosing. The empty-Astro path above
  // is untouched — this is the other way in, not a replacement for it.
  const startFromLumos = async () => {
    setError(null);
    const result = await window.avb.parentDialog();
    if (result.canceled) return;
    if (result.error) {
      setError(result.error);
      return;
    }
    setStarterDir(result.parentPath);
  };

  return (
    <div className="welcome">
      <WelcomeBackground />
      {/* Hero fills the space above the recents strip, centered in it. */}
      <div className="welcome-hero">
        <StackiLogo width={320} className="welcome-logo" />
        <p className="welcome-tagline">Visual Builder for Astro</p>
        {/* Ordered by how often each is reached for, and weighted by the
            situation the screen is in. With projects below, the rail is how
            somebody returns to one and this row is for the project that is not
            in it; on a first run there is no rail, nothing to return to, and
            the useful thing is to start a site. Two of these make a new
            project, so the plain one has to say what makes it different. */}
        <div className="actions">
          <div className="actions-row">
            <button className={recents.length ? 'primary' : ''} onClick={openExisting}>
              Open Project…
            </button>
            <button className={recents.length ? '' : 'primary'} onClick={startFromLumos}>
              Start from Lumos…
            </button>
          </div>
          {/* Under the two, not beside them: it is the way in for somebody who
              wants none of what the others offer, and a third button in the row
              made the choice look like three of a kind. */}
          <button className="quiet" onClick={createNew}>
            Empty Astro project…
          </button>
        </div>
        {error && <div className="error-text">{error}</div>}
      </div>

      {recents.length > 0 && (
        <div className="recents">
          <div className="recents-title">Recent projects</div>
          <div className="recent-rail">
            {recents.map((r) => (
              <div
                key={r.path}
                className="recent-card"
                title={r.path}
                onClick={() => onOpen(r.path)}
              >
                <button
                  className="recent-remove"
                  title="Remove from recent projects"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.avb.removeRecent(r.path);
                    setRecents((prev) => prev.filter((p) => p.path !== r.path));
                  }}
                >
                  <CloseIcon size={11} />
                </button>
                <div className={`recent-thumb ${refreshing[r.path] ? 'busy' : ''}`}>
                  {r.thumb ? (
                    <img src={r.thumb} alt="" draggable={false} />
                  ) : (
                    <LayersIcon size={22} strokeWidth={1.2} />
                  )}
                </div>
                <div className="recent-name">{r.name}</div>
                <div className="recent-path">{r.path}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {starterDir && (
        <StarterWizard
          parentPath={starterDir}
          onClose={() => setStarterDir(null)}
          onDone={(dir) => {
            setStarterDir(null);
            showToast('Site created', 'success');
            onOpen(dir);
          }}
        />
      )}

      {newProjectDir && (
        <NewProjectWizard
          dir={newProjectDir}
          onClose={() => setNewProjectDir(null)}
          onDone={(dir) => {
            setNewProjectDir(null);
            showToast('Project created', 'success');
            onOpen(dir);
          }}
        />
      )}
    </div>
  );
}

// The choices `npm create astro@latest` asks for interactively.
const TEMPLATES = [
  { value: 'basics', label: 'Basics', hint: 'A basic, helpful starter project' },
  { value: 'blog', label: 'Blog', hint: 'Content collections and post routing' },
  { value: 'starlight', label: 'Docs (Starlight)', hint: "Astro's documentation theme" },
  { value: 'minimal', label: 'Empty', hint: 'Nothing but the essentials' },
];

// Runs the real create-astro CLI with the answers collected here, streaming
// its output so it reads like the terminal session it replaces.
// Starting from the Lumos starter: a name for the site, the folder it lands in,
// and the scaffolder itself with its output where it can be read. The name is
// the folder's name, so it is checked the way a folder name has to be — the app
// can rename a site later, but it cannot rename it out of a folder that already
// exists.
function StarterWizard({ parentPath, onClose, onDone }) {
  const [name, setName] = useState('my-site');
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(null);
  const [log, setLog] = useState('');
  const logRef = useRef(null);

  useEffect(() => window.avb.onCreateLog((chunk) => setLog((l) => l + chunk)), []);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const invalid = !name.trim() || !/^[A-Za-z0-9._-]+$/.test(name.trim());

  const run = async () => {
    setRunning(true);
    setFailed(null);
    setLog('');
    try {
      const { projectPath } = await window.avb.createStarter({
        starter: 'lumos',
        parentPath,
        name: name.trim(),
      });
      onDone(projectPath);
    } catch (err) {
      setRunning(false);
      setFailed(cleanError(err));
    }
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}
    >
      <div className="modal new-project-modal">
        <div className="modal-header">Start from Lumos</div>
        <div className="modal-body">
          <label className="starter-field">
            <span>Site name</span>
            <input
              autoFocus
              value={name}
              spellCheck={false}
              disabled={running}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !invalid && !running) run();
              }}
            />
          </label>
          <div className="new-project-dir" title={`${parentPath}/${name.trim() || 'my-site'}`}>
            {`${parentPath}/${name.trim() || 'my-site'}`}
          </div>
          <div className="starter-note">
            Runs <code>npm create lumos@latest</code>, then starts a git history of its
            own — so publishing it later publishes your site, not a fork of the starter.
          </div>

          {(running || log) && (
            <pre className="create-log" ref={logRef}>
              {log}
            </pre>
          )}
          {failed && <div className="error-text">{failed}</div>}
        </div>
        <div className="modal-footer">
          <button className="ghost" onClick={onClose} disabled={running}>
            Cancel
          </button>
          <button className="primary" onClick={run} disabled={running || invalid}>
            {running ? 'Creating…' : 'Create site'}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewProjectWizard({ dir, onClose, onDone }) {
  const [template, setTemplate] = useState('basics');
  const [install, setInstall] = useState(true);
  const [git, setGit] = useState(true);
  const [ai, setAi] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState('');
  const [failed, setFailed] = useState(null);
  const logRef = React.useRef(null);

  useEffect(() => {
    const off = window.avb.onCreateLog((chunk) => setLog((prev) => (prev + chunk).slice(-20000)));
    return off;
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const run = async () => {
    setRunning(true);
    setFailed(null);
    setLog('');
    try {
      await window.avb.createAstroProject({ dir, template, install, git, ai });
      onDone(dir);
    } catch (err) {
      setRunning(false);
      setFailed(cleanError(err));
    }
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}
    >
      <div className="modal new-project-modal">
        <div className="modal-header">New Astro Project</div>
        <div className="modal-body">
          <div className="new-project-dir" title={dir}>
            {dir}
          </div>

          {!running && !failed && (
            <>
              <div>
                <label>How would you like to start your new project?</label>
                <div className="template-list">
                  {TEMPLATES.map((t) => (
                    <div
                      key={t.value}
                      className={`template-option ${template === t.value ? 'on' : ''}`}
                      onClick={() => setTemplate(t.value)}
                    >
                      <div className="template-name">{t.label}</div>
                      <div className="template-hint">{t.hint}</div>
                    </div>
                  ))}
                </div>
              </div>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={install}
                  onChange={(e) => setInstall(e.target.checked)}
                />
                Install dependencies
              </label>
              <label className="check-row">
                <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} />
                Initialize a new git repository
              </label>
              <label className="check-row">
                <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} />
                Add AI agent files
              </label>
            </>
          )}

          {(running || failed) && (
            <pre className="create-log" ref={logRef}>
              {log || 'Starting…'}
            </pre>
          )}
          {failed && <div className="error-text">{failed}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} disabled={running}>
            {failed ? 'Close' : 'Cancel'}
          </button>
          <button className="primary" onClick={run} disabled={running}>
            {running ? 'Creating…' : failed ? 'Try again' : 'Create Project'}
          </button>
        </div>
      </div>
    </div>
  );
}
