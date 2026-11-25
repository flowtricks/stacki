import { useTranslate } from '../../lib/i18n/useTranslate';
import { ErrorToast } from '../../ui/ErrorToast';
import CloneRepositoryModal from './CloneRepositoryModal';
import WelcomeSplitButton from './WelcomeSplitButton';
import React, { useEffect, useRef, useState } from 'react';
import { chooseSiteFolder, chooseStarterParent, listRecentProjects, refreshRecentThumbnail, removeRecentProject, type RecentProject } from './welcomeBridge';
import { AstroIcon, CloseIcon, FolderIcon, GitHubIcon, LayersIcon, LumosIcon } from '../../ui/Icons';
import StackiLogo from './StackiLogo';
import WelcomeShaderBackground from './WelcomeShaderBackground';
import { railScrollbarFor, watchRailEdges } from './recentRail';
import { currentDesktopPlatform } from '../../lib/shortcutLabel';
import { NewProjectWizard, StarterWizard } from './WelcomeWizards';
import ShadcnStarterWizard from './ShadcnStarterWizard';
import { ShadcnStarterLogo } from '../../ui/ShadcnStarterLogo';
import AstroCopyDialog, { announceAstroCopy, type AstroCopySource } from './AstroCopyDialog';
import { FolderDropHost, useFolderChoiceRoute } from './FolderDropHost';

interface WelcomeScreenProps {
  readonly onOpen: (projectPath: string) => void;
  readonly showToast: (message: string, kind: 'success' | 'error' | 'info') => void;
}

const PROJECT_WIZARDS = { astro: NewProjectWizard, lumos: StarterWizard, shadcn: ShadcnStarterWizard };
type ProjectWizardKind = keyof typeof PROJECT_WIZARDS;
interface ProjectCreation {
  readonly kind: ProjectWizardKind;
  readonly parentPath: string;
}

export default function WelcomeScreen({ onOpen, showToast }: WelcomeScreenProps) {
  const translate = useTranslate();
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [creation, setCreation] = useState<ProjectCreation | undefined>(undefined);
  const [copySource, setCopySource] = useState<AstroCopySource | undefined>(undefined);
  const recent = useRecentProjects(showToast);
  const actions = useWelcomeActions(onOpen, setError, setCreation, setCopySource);
  const ProjectWizard = PROJECT_WIZARDS[creation?.kind ?? 'lumos'];
  // A folder dropped on the window or on the app's icon: what "Open from folder" does with the same folder.
  const routeFolder = useFolderChoiceRoute({ open: onOpen, offerCopy: setCopySource, showToast });

  return (
    <div className="welcome">
      <WelcomeShaderBackground />
      <WelcomeHero
        hasRecents={recent.projects.length > 0}
        error={error}
        openExisting={() => void actions.openExisting()}
        startProject={(kind) => void actions.startProject(kind)}
        cloneRepository={() => setCloning(true)}
      />
      <RecentRail projects={recent.projects} refreshing={recent.refreshing} open={onOpen} remove={(projectPath) => void recent.remove(projectPath)} />
      <FolderDropHost onChoice={routeFolder} showToast={showToast} />
      {cloning && (
        <CloneRepositoryModal
          onClose={() => setCloning(false)}
          onOpen={(directory) => {
            setCloning(false);
            onOpen(directory);
          }}
        />
      )}
      {copySource && (
        <AstroCopyDialog
          source={copySource}
          onClose={() => setCopySource(undefined)}
          onDone={(created) => {
            setCopySource(undefined);
            announceAstroCopy(created, translate, showToast);
            onOpen(created.projectPath);
          }}
        />
      )}
      {creation && (
        <ProjectWizard
          parentPath={creation.parentPath}
          onClose={() => setCreation(undefined)}
          onDone={(directory) => {
            setCreation(undefined);
            showToast(translate(creation.kind === 'astro' ? 'welcome.projectCreated' : 'welcome.siteCreated'), 'success');
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
  setCreation: React.Dispatch<React.SetStateAction<ProjectCreation | undefined>>,
  setCopySource: React.Dispatch<React.SetStateAction<AstroCopySource | undefined>>,
) {
  const translate = useTranslate();
  // An Astro project opens; a plain website folder is offered an Astro copy; anything else is a toast.
  const openExisting = async (): Promise<void> => {
    setError(undefined);
    const result = await chooseSiteFolder();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const choice = result.value;
    switch (choice.kind) {
      case 'canceled':
        return;
      case 'astro':
        onOpen(choice.projectPath);
        return;
      case 'plainWebsite':
        setCopySource({ sourcePath: choice.sourcePath, parentPath: choice.parentPath, name: choice.name, homePath: choice.homePath });
        return;
      case 'notWebsite':
        setError(translate('welcome.notWebsite'));
        return;
      default: {
        const exhaustive: never = choice;
        return exhaustive;
      }
    }
  };
  // Each wizard names the site's folder after the native picker chooses its parent.
  const startProject = async (kind: ProjectWizardKind): Promise<void> => {
    setError(undefined);
    const result = await chooseStarterParent();
    if (!result.ok) {
      setError(result.error);
    } else if (!result.value.canceled) {
      setCreation({ kind, parentPath: result.value.parentPath });
    }
  };
  return { openExisting, startProject };
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
        setQueue(result.value.filter((project) => project.canRefresh && (project.stale || !project.thumb)));
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
  return projects.map((project) => (project.path === projectPath ? { ...project, thumb: result.thumb, stale: result.stale } : project));
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
  startProject,
  cloneRepository,
}: {
  readonly hasRecents: boolean;
  readonly error: string | undefined;
  readonly openExisting: () => void;
  readonly startProject: (kind: ProjectWizardKind) => void;
  readonly cloneRepository: () => void;
}) {
  const translate = useTranslate();
  return (
    <div className="welcome-hero">
      <StackiLogo width={320} className="welcome-logo" />
      <div className="actions">
        <div className="actions-row">
          <WelcomeSplitButton
            className={hasRecents ? 'primary' : ''}
            label={translate('welcome.hero.openFolder')}
            icon={<FolderIcon size={12} />}
            items={[{ label: translate('welcome.hero.openGitHub'), icon: <GitHubIcon size={15} />, onSelect: cloneRepository }]}
            menuTitle={translate('welcome.hero.moreOpen')}
            onClick={openExisting}
          />
          <WelcomeSplitButton
            className={hasRecents ? '' : 'primary'}
            label={translate('welcome.hero.startLumos')}
            icon={<LumosIcon size={15} />}
            items={[
              { label: translate('welcome.hero.startAstro'), icon: <AstroIcon size={15} />, onSelect: () => startProject('astro') },
              { label: translate('welcome.hero.startShadcn'), icon: <ShadcnStarterLogo brand="shadcn" size={15} />, onSelect: () => startProject('shadcn') },
            ]}
            menuTitle={translate('welcome.hero.moreStart')}
            onClick={() => startProject('lumos')}
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
  const translate = useTranslate();
  if (projects.length === 0) {
    return undefined;
  }
  return (
    <div className="recents">
      <RecentRailScroller>
        {projects.map((project) => (
          <div key={project.path} className="recent-card" title={project.path} onClick={() => open(project.path)}>
            <button
              className="recent-remove"
              title={translate('welcome.recent.remove')}
              onClick={(event) => {
                event.stopPropagation();
                remove(project.path);
              }}
            >
              <CloseIcon size={11} />
            </button>
            <div className={`recent-thumb ${refreshing.has(project.path) ? 'busy' : ''}`}>
              {project.thumb ? <img src={project.thumb} alt="" draggable={false} /> : <LayersIcon size={22} strokeWidth={1.2} />}
            </div>
            <div className="recent-name">{project.name}</div>
            <div className="recent-path">{project.path}</div>
          </div>
        ))}
      </RecentRailScroller>
    </div>
  );
}

// The scrolling row itself. It is its own component so the rail element exists
// for exactly as long as the edge watcher that reads it.
function RecentRailScroller({ children }: { readonly children: React.ReactNode }) {
  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rail = railRef.current;
    if (rail === null) {
      return undefined;
    }
    return watchRailEdges(rail, { scrollbar: railScrollbarFor(currentDesktopPlatform()) });
  }, []);
  return (
    <div ref={railRef} className="recent-rail">
      {children}
    </div>
  );
}
