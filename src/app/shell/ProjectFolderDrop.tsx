// A folder dropped on the project window, or handed over by the app's icon while a project is open. Stacki has
// one window, so opening another project is what File > Open Project does: the edits go to disk, the window
// lets go of this project and comes back in the other (leaveProject). A plain website gets the Astro copy here,
// and the copy opens the same way once it is made.
import { useState } from 'react';
import type { ShellView } from '../App';
import AstroCopyDialog, { announceAstroCopy, type AstroCopySource } from '../../features/welcome/AstroCopyDialog';
import { FolderDropHost, useFolderChoiceRoute } from '../../features/welcome/FolderDropHost';
import { windowHeld } from '../../ui/busyLock';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { cleanError } from '../../lib/cleanError';

export function ProjectFolderDrop({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const [copySource, setCopySource] = useState<AstroCopySource | undefined>(undefined);
  const switchTo = (projectPath: string): void => {
    // A cover holds the window: the work under it belongs to this project, as for the menu's Open Project.
    if (windowHeld()) {
      return;
    }
    if (projectPath === app.project.path) {
      app.showToast(translate('welcome.drop.alreadyOpen'), 'info');
      return;
    }
    void app.leaveProject(projectPath).catch((error: unknown) => {
      app.showToast(translate('shell.project.closeFailed', { message: cleanError(error) }), 'error');
    });
  };
  const route = useFolderChoiceRoute({ open: switchTo, offerCopy: setCopySource, showToast: app.showToast });
  return (
    <>
      <FolderDropHost onChoice={route} showToast={app.showToast} />
      {copySource && (
        <AstroCopyDialog
          source={copySource}
          onClose={() => setCopySource(undefined)}
          onDone={(created) => {
            setCopySource(undefined);
            announceAstroCopy(created, translate, app.showToast);
            switchTo(created.projectPath);
          }}
        />
      )}
    </>
  );
}
