import { useStudioTranslatorBridge } from '../shared/studioTranslate';
import { useAstroFileNotifications } from '../features/notifications/useAstroFileNotifications';
import { useEditorNavigation } from '../features/project/editorNavigation';
import { useEffect } from 'react';
import { useProjectLoad } from '../features/project/useProjectLoad';
import { useStartupView } from '../features/startup/useStartupView';
import { pageAddressHost } from '../features/project/pageAddress';
import { BootScreen } from './BootScreen';
import { Editor } from './Editor';
import { useEditorView } from './useEditorView';
import { useSession } from '../features/auth/useSession';
import { useStudioRoles } from '../features/roles/useStudioRoles';
import { Toast } from '../features/notifications/Toast';
import { useNotifications } from '../features/notifications/useNotifications';

export function App() {
  useStudioTranslatorBridge();
  const view = useEditorView();
  const navigation = useEditorNavigation();
  const { notices, performAction, report, dismiss } = useNotifications();
  const { project, refresh, reconcile, attempt, failure, revision } = useProjectLoad(report);
  useEffect(() => {
    // A host that keeps the address in step also keeps the title: the open page's own.
    if (pageAddressHost() === undefined) {
      document.title = project ? `Stacki - ${project.name}` : 'Stacki';
    }
  }, [project]);
  // While the project is not here the container may be cold: ask the Worker what it is doing.
  const startup = useStartupView(!project, 0);
  useAstroFileNotifications(report, refresh, reconcile);
  const session = useSession(report);
  const roles = useStudioRoles(session, revision, report);
  return (
    <>
      {project && roles === 'ready' ? (
        <Editor
          {...navigation}
          view={view}
          session={session}
          project={project}
          follow={(peer) => {
            view.setPanel('navigator');
            navigation.follow(peer);
          }}
          refresh={refresh}
          report={report}
        />
      ) : (
        <BootScreen
          key={revision}
          attempt={attempt}
          failure={failure}
          authenticated={!!session}
          startup={startup}
          retry={() => {
            refresh();
          }}
        />
      )}
      <Toast notices={notices} performAction={performAction} dismiss={dismiss} />
    </>
  );
}
