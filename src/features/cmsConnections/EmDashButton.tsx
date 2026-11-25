// EmDash in Settings: a button in the CMS row, beside Payload and Custom CMS, that opens a dialog (EmDashDialog) with what
// Stacki found in the project and, when EmDash is not there, a way to add it to this project. EmDash is detected from the
// project's own files; there is no key to paste. Content types are read from EmDash and only shown; nothing edits them.
//
// The project is read when the button mounts, so the connected mark shows without opening the dialog and the dialog
// renders what is already known at once; skeleton rows show only while that first read is still out. When the dialog adds
// EmDash, it hands the re-read project back here, so the mark follows without reopening Settings.
//
// Focus: the dialog is a native modal (Popup), which returns focus to the element that was focused when it opened, and a
// press on this button focuses it first, so closing by Escape, the close button or the backdrop lands back here.
import { useEffect, useState } from 'react';
import { EmDashIcon } from '../../ui/Icons';
import { EMDASH_HOST, readEmDashProject } from '../../ipc/emdashBridge';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { EmDashProject } from '../../../shared/properties/emdash';
import { EmDashDialog } from './EmDashDialog';

export function EmDashButton({ projectPath }: { readonly projectPath: string }) {
  const translate = useTranslate();
  const [project, setProject] = useState<EmDashProject | undefined>(undefined);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let current = true;
    if (EMDASH_HOST.available) {
      readEmDashProject(projectPath).then(
        (found) => current && setProject(found),
        // A project that cannot be read is shown as having no EmDash: the button never blocks the other connections.
        () => current && setProject({ kind: 'absent' }),
      );
    }
    return () => {
      current = false;
    };
  }, [projectPath]);
  if (!EMDASH_HOST.available) {
    return <></>;
  }
  return (
    <>
      <button
        type="button"
        data-cms="emdash"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          // Some platforms do not focus a button on press; the dialog gives focus back to what had it.
          event.currentTarget.focus();
          setOpen(true);
        }}
      >
        <span className="cms-connect-icon">
          <EmDashIcon size={14} />
          {project?.kind === 'present' && <span className="cms-connect-status" role="img" aria-label={translate('emdash.button.connected')} />}
        </span>
        {/* i18n-ignore: EmDash is a product name. */}
        EmDash
      </button>
      {open && <EmDashDialog projectPath={projectPath} project={project} onProject={setProject} onClose={() => setOpen(false)} />}
    </>
  );
}
