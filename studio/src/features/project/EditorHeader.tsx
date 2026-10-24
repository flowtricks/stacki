import { isCanvasPage } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import type { Peer } from '../collaboration/presence';
import type { Session } from '../auth/useSession';
import { AccountMenu } from '../auth/AccountMenu';
import { Avatar } from '../auth/Avatar';
import type { Project } from './projectClient';
import { PublishButton } from '../publishing/PublishButton';
import type { SharedDocument } from '../collaboration/useDocument';
import { presenceUsers } from '../collaboration/presenceUsers';
import { presenceColor } from '../collaboration/presenceColors';
import PageSwitcher from '../../../vendor/stacki/src/features/pages/PageSwitcher';
import { routeFor } from './projectClient';
import { useComponentBack } from './useComponentBack';
import { useEditorRole } from '../roles/useEditorRole';
import { PreviewButton, type InteractivePreviewState } from '../preview/InteractivePreview';
interface HeaderProps {
  readonly cursorChat: (() => void) | undefined;
  readonly defaultsMode: boolean;
  readonly closeDefaults: () => void;
  readonly interactivePreview: InteractivePreviewState;
  readonly session: Session | undefined;
  readonly follow: (peer: Peer) => void;
  readonly project: Project;
  readonly file: string;
  readonly previewFile: string;
  readonly open: (file: string) => void;
  readonly document: SharedDocument | undefined;
  readonly report: (error: unknown) => void;
}

export function EditorHeader({
  cursorChat,
  project,
  file,
  previewFile,
  open,
  document,
  report,
  follow,
  session,
  interactivePreview,
  closeDefaults,
  defaultsMode,
}: HeaderProps) {
  const role = useEditorRole();
  const direct = session?.kind === 'local' && session.editing === 'source';
  const pages = headerPages(project);
  const componentOpen = !isCanvasPage(file) && file.endsWith('.astro');
  const back = defaultsMode
    ? closeDefaults
    : () => headerBack({ document, previewFile, open, report });
  useComponentBack((componentOpen || defaultsMode) && !interactivePreview.active, back);
  const switcher = (
    <PageSwitcher
      pages={pages}
      currentPage={pages.find((page) => page.path === previewFile)}
      onSelect={(page) => open(page.path)}
    />
  );
  return (
    <header className={`titlebar studio-titlebar ${componentOpen ? 'component-open' : ''}`}>
      <div className="studio-titlebar-start">
        <AccountMenu
          saved={!defaultsMode && document?.status === 'Saved'}
          session={session}
          cursorChat={cursorChat}
        />
        <span className="project-name">{project.name}</span>
        <span className="draft-chip">{direct ? 'Local files' : 'Draft'}</span>
        {role === 'client' && <span className="client-role-badge">Client</span>}
        {componentOpen && switcher}
      </div>
      <div className="studio-titlebar-center">
        <HeaderNavigation
          defaultsMode={defaultsMode}
          componentOpen={componentOpen}
          back={back}
          file={file}
          switcher={switcher}
        />
      </div>
      <div className="studio-titlebar-end">
        <Collaborators document={document} session={session} follow={follow} />
        <span className="save-state">{document?.status ?? 'Connecting'}</span>
        <PreviewButton preview={interactivePreview} />
        {!direct && <PublishButton report={report} />}
      </div>
    </header>
  );
}

function headerBack({
  document,
  previewFile,
  open,
  report,
}: Pick<HeaderProps, 'document' | 'previewFile' | 'open' | 'report'>) {
  if (!document) {
    open(previewFile);
    return;
  }
  void document
    .whenSaved()
    .then(() => open(previewFile))
    .catch(report);
}

function headerPages(project: Project) {
  return project.pages.map((path) => ({
    path,
    name: path.replace(/^src\/pages\//, ''),
    route: routeFor(path),
  }));
}

function Collaborators({
  document,
  session,
  follow,
}: {
  document: SharedDocument | undefined;
  session: Session | undefined;
  follow: (peer: Peer) => void;
}) {
  return (
    <div className="collaborators">
      {presenceUsers(document?.peers ?? []).map((peer) => (
        <button
          type="button"
          onClick={() => follow(peer)}
          aria-label={`Go to ${peer.name}’s selection`}
          key={peer.githubId === undefined ? `connection:${peer.id}` : `github:${peer.githubId}`}
          title={`${peer.name} · ${peer.page}${peer.selection ? ' · ' + peer.selection : ''}`}
          style={
            peer.id === document?.selfId ||
            (session?.kind === 'github' && peer.githubId === session.id)
              ? undefined
              : { background: presenceColor(peer), borderColor: presenceColor(peer) }
          }
        >
          <Avatar
            id={
              peer.githubId ??
              (session?.kind === 'github' && session.login.toLowerCase() === peer.name.toLowerCase()
                ? session.id
                : undefined)
            }
            name={peer.name}
          />
        </button>
      ))}
    </div>
  );
}

function HeaderNavigation({
  defaultsMode,
  componentOpen,
  back,
  file,
  switcher,
}: {
  readonly defaultsMode: boolean;
  readonly componentOpen: boolean;
  readonly back: () => void;
  readonly file: string;
  readonly switcher: React.ReactNode;
}) {
  return (
    <>
      {defaultsMode ? (
        <button
          className="page-switch-btn comp-back"
          onClick={back}
          title="Close defaults"
          aria-label="Close defaults"
          aria-keyshortcuts="Escape"
        >
          <span>←</span>
          <span>Close defaults</span>
        </button>
      ) : componentOpen ? (
        <button
          className="page-switch-btn comp-back"
          onClick={back}
          title="Back to page"
          aria-keyshortcuts="Escape"
        >
          <span>←</span>
          <span className="page-switch-label">{file.split('/').at(-1)}</span>
        </button>
      ) : (
        switcher
      )}
    </>
  );
}
