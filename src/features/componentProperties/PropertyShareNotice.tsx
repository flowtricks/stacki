// What a prop's edits reach beyond this component. A prop declared by a shared
// type (`SeoProps` in src/types.ts) is edited in that file, so the form says
// so before anything is changed, and lists the components using the type and
// the files placing them; a prop whose options live in a shared alias carries
// the reader's warning. Both are said in the form rather than as a toast, so
// they are on screen while the edit is made.

import { useState } from 'react';
import type { ComponentProperty, PropertyShare } from '../../../shared/properties/propertyEditing';
import { CodeInline } from '../../ui/CodeBlock';

interface ShareNoticeProps {
  readonly property: ComponentProperty;
  /** Opens a project file, named project-relative, in the code panel. */
  readonly onOpenFile: ((path: string) => void) | undefined;
}

export function PropertyShareNotice({ property, onOpenFile }: ShareNoticeProps) {
  const [open, setOpen] = useState(false);
  const share = property.shared;
  const warning = property.editing?.kind === 'editable' ? property.editing.warning : undefined;
  if (share === undefined) {
    return warning === undefined ? undefined : (
      <p className="property-share-warning" role="note">
        {warning}
      </p>
    );
  }
  return (
    <div className="property-share" role="note">
      <button type="button" className="property-share-summary" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {shareSummary(share)}
      </button>
      {open && <ShareFiles share={share} onOpenFile={onOpenFile} />}
      <ShareDefaults share={share} />
    </div>
  );
}

/** "Shared: edits SeoProps in src/types.ts, used by 2 components (BaseLayout, BaseHead) and their instances." */
export function shareSummary(share: PropertyShare): string {
  const names = share.users.map(componentName);
  const count = names.length === 1 ? '1 component' : `${names.length} components`;
  return `Shared: edits ${share.typeName} in ${share.path}, used by ${count} (${names.join(', ')}) and their instances.`;
}

/** The files a rename of a shared prop rewrites: the type's file, its users and their instances. */
export function shareRenameFiles(share: PropertyShare): readonly string[] {
  return [...new Set([share.path, ...share.users, ...share.instances])];
}

function ShareFiles({ share, onOpenFile }: { readonly share: PropertyShare; readonly onOpenFile: ShareNoticeProps['onOpenFile'] }) {
  return (
    <div className="property-share-files">
      <ShareFileList label="Declared in" files={[share.path]} onOpenFile={onOpenFile} />
      <ShareFileList label="Components" files={share.users} onOpenFile={onOpenFile} />
      {share.instances.length > 0 && <ShareFileList label="Instances in" files={share.instances} onOpenFile={onOpenFile} />}
    </div>
  );
}

function ShareFileList({
  label,
  files,
  onOpenFile,
}: {
  readonly label: string;
  readonly files: readonly string[];
  readonly onOpenFile: ShareNoticeProps['onOpenFile'];
}) {
  return (
    <div>
      <strong>{label}</strong>
      <ul>
        {files.map((file) => (
          <li key={file}>
            {onOpenFile === undefined ? (
              file
            ) : (
              <button type="button" className="property-share-file" onClick={() => onOpenFile(file)}>
                {file}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// A shared prop's default is each component's own, so the ones the other users give it are shown.
function ShareDefaults({ share }: { readonly share: PropertyShare }) {
  if (share.defaults.length === 0) {
    return undefined;
  }
  return (
    <div className="property-share-defaults">
      <strong>Defaults</strong>
      <ul>
        {share.defaults.map((entry) => (
          <li key={entry.path}>
            {componentName(entry.path)}: <CodeInline text={entry.expression} language="typescript" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function componentName(file: string): string {
  const base = file.split('/').pop() ?? file;
  return base.replace(/\.astro$/, '');
}
