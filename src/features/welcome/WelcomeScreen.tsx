import { ErrorToast } from '../../ui/ErrorToast';
import CloneRepositoryModal from './CloneRepositoryModal';
import WelcomeSplitButton from './WelcomeSplitButton';
import React, { useEffect, useRef, useState } from 'react';
import {
  chooseExistingProject,
  chooseStarterParent,
  listRecentProjects,
  refreshRecentThumbnail,
  removeRecentProject,
  type RecentProject,
} from './welcomeBridge';
import { CloseIcon, LayersIcon } from '../../ui/Icons';
import StackiLogo from './StackiLogo';
import WelcomeBackground from './WelcomeBackground';
import { NewProjectWizard, StarterWizard } from './WelcomeWizards';

interface WelcomeScreenProps {
  readonly onOpen: (projectPath: string) => void;
  readonly showToast: (message: string, kind: 'success' | 'error' | 'info') => void;
}

export default function WelcomeScreen({ onOpen, showToast }: WelcomeScreenProps) {
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [newProjectParent, setNewProjectParent] = useState<string | undefined>(undefined);
  const [starterDirectory, setStarterDirectory] = useState<string | undefined>(undefined);
  const recent = useRecentProjects(showToast);
  const actions = useWelcomeActions(onOpen, setError, setNewProjectParent, setStarterDirectory);

  return (
    <div className="welcome">
      <WelcomeBackground />
      <WelcomeHero
        hasRecents={recent.projects.length > 0}
        error={error}
        openExisting={() => void actions.openExisting()}
        startFromLumos={() => void actions.startFromLumos()}
        createNew={() => void actions.createNew()}
        cloneRepository={() => setCloning(true)}
      />
      <RecentRail
        projects={recent.projects}
        refreshing={recent.refreshing}
        open={onOpen}
        remove={(projectPath) => void recent.remove(projectPath)}
      />
      {cloning && (
        <CloneRepositoryModal
          onClose={() => setCloning(false)}
          onOpen={(directory) => {
            setCloning(false);
            onOpen(directory);
          }}
        />
      )}
      {starterDirectory && (
        <StarterWizard
          parentPath={starterDirectory}
          onClose={() => setStarterDirectory(undefined)}
          onDone={(directory) => {
            setStarterDirectory(undefined);
            showToast('Site created', 'success');
            onOpen(directory);
          }}
        />
      )}
      {newProjectParent && (
        <NewProjectWizard
          parentPath={newProjectParent}
          onClose={() => setNewProjectParent(undefined)}
          onDone={(directory) => {
            setNewProjectParent(undefined);
            showToast('Project created', 'success');
            onOpen(directory);
          }}
        />
      )}
    </div>
  );
}

function useWelcomeActions(
  onOpen: WelcomeScreenProps['onOpen'],
  setError: React.Dispatch<React.SetStateAction<string | undefined>>,
  setNewProjectParent: React.Dispatch<React.SetStateAction<string | undefined>>,
  setStarterDirectory: React.Dispatch<React.SetStateAction<string | undefined>>,
) {
  const openExisting = async (): Promise<void> => {
    setError(undefined);
    const result = await chooseExistingProject();
    if (!result.ok) {
      setError(result.error);
    } else if (!result.value.canceled && 'error' in result.value) {
      setError(result.value.error);
    } else if (!result.value.canceled) {
      onOpen(result.value.projectPath);
    }
  };
  // Both wizards ask where the site should go and name its folder themselves.
  const createNew = async (): Promise<void> => {
    setError(undefined);
    const result = await chooseStarterParent();
    if (!result.ok) {
      setError(result.error);
    } else if (!result.value.canceled) {
      setNewProjectParent(result.value.parentPath);
    }
  };
  const startFromLumos = async (): Promise<void> => {
    setError(undefined);
    const result = await chooseStarterParent();
    if (!result.ok) {
      setError(result.error);
    } else if (!result.value.canceled) {
      setStarterDirectory(result.value.parentPath);
    }
  };
  return { openExisting, createNew, startFromLumos };
}

function useRecentProjects(showToast: WelcomeScreenProps['showToast']) {
  const [projects, setProjects] = useState<readonly RecentProject[]>([]);
  const [queue, setQueue] = useState<readonly RecentProject[]>([]);
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(() => new Set());
  const removedRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let active = true;
    void listRecentProjects().then((result) => {
      if (active && result.ok) {
        setProjects(result.value);
        setQueue(
          result.value.filter((project) => project.canRefresh && (project.stale || !project.thumb)),
        );
      }
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => refreshQueue(queue, removedRef, setProjects, setRefreshing), [queue]);
  const remove = async (projectPath: string): Promise<void> => {
    const result = await removeRecentProject(projectPath);
    if (!result.ok) {
      showToast(result.error, 'error');
      return;
    }
    removedRef.current = new Set([...removedRef.current, projectPath]);
    setProjects((previous) => previous.filter((project) => project.path !== projectPath));
    setRefreshing((previous) => withoutPath(previous, projectPath));
  };
  return { projects, refreshing, remove };
}

function refreshQueue(
  queue: readonly RecentProject[],
  removedRef: React.MutableRefObject<ReadonlySet<string>>,
  setProjects: React.Dispatch<React.SetStateAction<readonly RecentProject[]>>,
  setRefreshing: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
): () => void {
  let active = true;
  void (async () => {
    for (const project of queue) {
      if (!active) {
        return;
      }
      if (removedRef.current.has(project.path)) {
        continue;
      }
      setRefreshing((previous) => new Set([...previous, project.path]));
      const result = await refreshRecentThumbnail(project.path);
      if (active && result.ok && result.value.ok) {
        setProjects((previous) => updateThumbnail(previous, project.path, result.value));
      }
      if (active) {
        setRefreshing((previous) => withoutPath(previous, project.path));
      }
    }
  })();
  return () => {
    active = false;
  };
}

function updateThumbnail(
  projects: readonly RecentProject[],
  projectPath: string,
  result: { readonly thumb: string | undefined; readonly stale: boolean },
): readonly RecentProject[] {
  return projects.map((project) =>
    project.path === projectPath
      ? { ...project, thumb: result.thumb, stale: result.stale }
      : project,
  );
}

function withoutPath(paths: ReadonlySet<string>, projectPath: string): ReadonlySet<string> {
  const next = new Set(paths);
  next.delete(projectPath);
  return next;
}

function WelcomeHero({
  hasRecents,
  error,
  openExisting,
  startFromLumos,
  createNew,
  cloneRepository,
}: {
  readonly hasRecents: boolean;
  readonly error: string | undefined;
  readonly openExisting: () => void;
  readonly startFromLumos: () => void;
  readonly createNew: () => void;
  readonly cloneRepository: () => void;
}) {
  return (
    <div className="welcome-hero">
      <StackiLogo width={320} className="welcome-logo" />
      <p className="welcome-tagline">Visual Builder for Astro</p>
      <div className="actions">
        <div className="actions-row">
          <WelcomeSplitButton
            className={hasRecents ? 'primary' : ''}
            label="Open Project…"
            menuLabel="Open from GitHub…"
            menuTitle="More ways to open a project"
            onClick={openExisting}
            onMenuSelect={cloneRepository}
          />
          <WelcomeSplitButton
            className={hasRecents ? '' : 'primary'}
            label="Start from Lumos…"
            menuLabel="Empty Astro project…"
            menuTitle="More ways to start a project"
            onClick={startFromLumos}
            onMenuSelect={createNew}
          />
        </div>
      </div>
      {error && <ErrorToast message={error} />}
    </div>
  );
}

function RecentRail({
  projects,
  refreshing,
  open,
  remove,
}: {
  readonly projects: readonly RecentProject[];
  readonly refreshing: ReadonlySet<string>;
  readonly open: (projectPath: string) => void;
  readonly remove: (projectPath: string) => void;
}) {
  if (projects.length === 0) {
    return undefined;
  }
  return (
    <div className="recents">
      <div className="recents-title">Recent projects</div>
      <div className="recent-rail">
        {projects.map((project) => (
          <div
            key={project.path}
            className="recent-card"
            title={project.path}
            onClick={() => open(project.path)}
          >
            <button
              className="recent-remove"
              title="Remove from recent projects"
              onClick={(event) => {
                event.stopPropagation();
                remove(project.path);
              }}
            >
              <CloseIcon size={11} />
            </button>
            <div className={`recent-thumb ${refreshing.has(project.path) ? 'busy' : ''}`}>
              {project.thumb ? (
                <img src={project.thumb} alt="" draggable={false} />
              ) : (
                <LayersIcon size={22} strokeWidth={1.2} />
              )}
            </div>
            <div className="recent-name">{project.name}</div>
            <div className="recent-path">{project.path}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
