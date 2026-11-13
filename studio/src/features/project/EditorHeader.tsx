import { saveStatusLabel } from '../collaboration/saveStatus';
import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
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
import { useComponentBack } from './useComponentBack';
import { TemplateEntryPicker } from '../pages/TemplateEntryPicker';
import { useStudioRole } from '../roles/useEditorRole';
import { projectPages } from './pageLabels';
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
  const translate = useTranslate();
  const studioRole = useStudioRole();
  const direct = session?.kind === 'local' && session.editing === 'source';
  const pages = projectPages(project);
  const componentOpen = !isCanvasPage(file) && file.endsWith('.astro');
  const back = defaultsMode ? closeDefaults : () => headerBack({ document, previewFile, open, report });
  useComponentBack((componentOpen || defaultsMode) && !interactivePreview.active, back);
  // A template page's entry switcher stands beside the page switcher, as on Desktop.
  const switcher = (
    <>
      <PageSwitcher pages={pages} currentPage={pages.find((page) => page.path === previewFile)} onSelect={(page) => open(page.path)} />
      <TemplateEntryPicker file={previewFile} />
    </>
  );
  return (
    <header className={`titlebar studio-titlebar ${componentOpen ? 'component-open' : ''}`}>
      <div className="studio-titlebar-start">
        <AccountMenu saved={!defaultsMode && document?.status === 'Saved'} session={session} cursorChat={cursorChat} />
        <span className="project-name">{project.name}</span>
        <span className="save-state" role="status" data-saved={document?.status === 'Saved' ? '' : undefined}>
          {saveStatusLabel(document?.status ?? 'Connecting', translate)}
        </span>
        {!studioRole.isAdmin && <span className="client-role-badge">{studioRole.name}</span>}
        {componentOpen && switcher}
      </div>
      <div className="studio-titlebar-center">
        <HeaderNavigation defaultsMode={defaultsMode} componentOpen={componentOpen} back={back} file={file} switcher={switcher} />
      </div>
      <div className="studio-titlebar-end">
        <Collaborators document={document} session={session} follow={follow} />
        <PreviewButton preview={interactivePreview} />
        {!direct && <PublishButton report={report} />}
      </div>
    </header>
  );
}

function headerBack({ document, previewFile, open, report }: Pick<HeaderProps, 'document' | 'previewFile' | 'open' | 'report'>) {
  if (!document) {
    open(previewFile);
    return;
  }
  void document
    .whenSaved()
    .then(() => open(previewFile))
    .catch(report);
}

function Collaborators({ document, session, follow }: { document: SharedDocument | undefined; session: Session | undefined; follow: (peer: Peer) => void }) {
  const translate = useTranslate();
  return (
    <div className="collaborators">
      {presenceUsers(document?.peers ?? []).map((peer) => (
        <button
          type="button"
          onClick={() => follow(peer)}
          aria-label={translate('studio.header.goToSelection', { name: peer.name })}
          key={peer.githubId === undefined ? `connection:${peer.id}` : `github:${peer.githubId}`}
          title={`${peer.name} · ${peer.page}${peer.selection ? ' · ' + peer.selection : ''}`}
          style={
            peer.id === document?.selfId || (session?.kind === 'github' && peer.githubId === session.id)
              ? undefined
              : { background: presenceColor(peer), borderColor: presenceColor(peer) }
          }
        >
          <Avatar
            id={peer.githubId ?? (session?.kind === 'github' && session.login.toLowerCase() === peer.name.toLowerCase() ? session.id : undefined)}
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
  const translate = useTranslate();
  return (
    <>
      {defaultsMode ? (
        <button
          className="page-switch-btn comp-back"
          onClick={back}
          title={translate('shell.titleBar.closeDefaults')}
          aria-label={translate('shell.titleBar.closeDefaults')}
          aria-keyshortcuts="Escape"
        >
          <span>←</span>
          <span>{translate('shell.titleBar.closeDefaults')}</span>
        </button>
      ) : componentOpen ? (
        <button className="page-switch-btn comp-back" onClick={back} title={translate('studio.header.backToPage')} aria-keyshortcuts="Escape">
          <span>←</span>
          <span className="page-switch-label">{file.split('/').at(-1)}</span>
        </button>
      ) : (
        switcher
      )}
    </>
  );
}
