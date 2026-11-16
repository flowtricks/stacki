// Rename a component, move it to another folder under the components root, or both, in one dialog. While the name is typed the
// field says at once whether `folder/name.astro` is free (renameAvailability.ts, no round trip), and once it is, main is asked
// which files would change (debounced, nothing written) so "N files will be updated" is on screen before anyone presses the button.
// The button stays blue and is disabled while the name is taken, invalid or unchanged, and while the preview is not ready.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Result } from '../../../shared/core/result';
import type { ComponentOpError } from '../../../shared/properties/componentOps';
import type { ComponentRenameRequest, ComponentRenameSummary, RenameNoticeKind } from '../../../shared/properties/componentRename';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import Dropdown from '../../ui/Dropdown';
import Popup from '../../ui/Popup';
import { detectFolderStyle, detectNamingStyle } from '../../../shared/properties/componentNaming';
import { folderInput, renameAvailability, type RenameCandidate } from './renameAvailability';
import './renameComponent.css';

/** How long typing pauses before main is asked for the file list. */
export const RENAME_PREVIEW_DELAY_MS = 100;
const NEW_FOLDER = '\u0000new-folder';

export interface RenameComponentDialogProps {
  /** The component's project-relative file, and its display name. */
  readonly file: string;
  readonly name: string;
  readonly components: readonly RenameCandidate[];
  /** The configured component folders (`src/components`); folders are chosen from these and what lies under them. */
  readonly roots: readonly string[];
  readonly focus: 'name' | 'folder';
  readonly plan: (request: ComponentRenameRequest) => Promise<Result<ComponentRenameSummary, ComponentOpError>>;
  readonly onClose: () => void;
  readonly onApply: (request: ComponentRenameRequest, change: 'rename' | 'move' | 'both') => void;
}

type Preview =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly summary: ComponentRenameSummary }
  | { readonly kind: 'error'; readonly message: string };

const NOTICE_KEYS: Readonly<
  Record<
    RenameNoticeKind,
    'palette.rename.notice.mention' | 'palette.rename.notice.unparsed' | 'palette.rename.notice.keptLocalName' | 'palette.rename.notice.namespace'
  >
> = {
  mention: 'palette.rename.notice.mention',
  unparsed: 'palette.rename.notice.unparsed',
  'kept-local-name': 'palette.rename.notice.keptLocalName',
  namespace: 'palette.rename.notice.namespace',
};

export function RenameComponentDialog(props: RenameComponentDialogProps) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const currentFolder = props.file.slice(0, props.file.lastIndexOf('/'));
  const root = props.roots.find((candidate) => props.file.startsWith(`${candidate}/`)) ?? currentFolder;
  const [name, setName] = useState(props.name);
  const [folder, setFolder] = useState(currentFolder);
  const [newFolder, setNewFolder] = useState('');
  const folders = useMemo(() => folderChoices(props.roots, props.components, currentFolder), [props.roots, props.components, currentFolder]);
  const creatingFolder = folder === NEW_FOLDER;
  const style = useMemo(() => detectNamingStyle(props.components.map((component) => baseOf(component.file))), [props.components]);
  const folderStyle = useMemo(() => detectFolderStyle(folderLevels(folders, props.roots)), [folders, props.roots]);
  const typedFolder = folderInput(newFolder, folderStyle);
  const folderProblem = creatingFolder ? typedFolder.problem : undefined;
  const chosenFolder = creatingFolder ? `${root}/${typedFolder.path}` : folder;
  const availability = renameAvailability({ current: props.file, name, folder: chosenFolder, style, components: props.components });
  const request: ComponentRenameRequest | undefined =
    availability.kind === 'available' && folderProblem === undefined ? { from: props.file, to: availability.path } : undefined;
  const preview = usePreview(request, props.plan);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
    if (props.focus === 'name') {
      nameRef.current?.select();
    }
  }, [props.focus]);
  const ready = request !== undefined && preview.kind === 'ready';
  const nameChanged = availability.kind === 'available' && availability.fileName !== baseOf(props.file);
  const change = nameChanged ? (chosenFolder === currentFolder ? 'rename' : 'both') : 'move';
  const submit = (): void => {
    if (ready) {
      props.onApply(request, change);
    }
  };
  return (
    <Popup className="modal rename-component" onClose={props.onClose} dismissible={true}>
      {({ close }) => (
        <>
          <div className="modal-header">{translate('palette.rename.title', { name: props.name })}</div>
          <div className="modal-body">
            <label>{translate('palette.rename.name')}</label>
            <input
              ref={nameRef}
              value={name}
              spellCheck={false}
              // i18n-ignore: an example component identifier, not prose.
              placeholder="Card"
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  submit();
                } else if (event.key === 'Escape') {
                  close();
                }
              }}
            />
            <div className={`rename-status is-${availability.kind}`} role="status">
              {availability.kind === 'available' && translate('palette.rename.available')}
              {availability.kind === 'taken' && translate('palette.rename.taken', { file: availability.by })}
              {availability.kind === 'same' && translate('palette.rename.unchanged')}
              {availability.kind === 'invalid' && translateDescribed(availability.problem)}
            </div>
            {availability.kind === 'available' && availability.change !== undefined && (
              <div className="rename-note">
                {translate(availability.change === 'spaces' ? 'palette.rename.spacesRemoved' : 'palette.rename.normalized', { name: availability.fileName })}
              </div>
            )}
            {availability.kind === 'available' && availability.sameNameIn !== undefined && (
              <div className="rename-warning">
                {translate('palette.rename.sameNameElsewhere', { name: availability.fileName, file: availability.sameNameIn })}
              </div>
            )}
            <label>{translate('palette.rename.folder')}</label>
            <Dropdown
              value={folder}
              ariaLabel={translate('palette.rename.folder')}
              options={[...folders.map((value) => ({ value, label: value })), { value: NEW_FOLDER, label: translate('palette.rename.newFolder') }]}
              onChange={setFolder}
            />
            {creatingFolder && (
              <>
                <input
                  value={newFolder}
                  spellCheck={false}
                  aria-label={translate('palette.rename.newFolderName')}
                  onChange={(event) => setNewFolder(event.currentTarget.value)}
                />
                {newFolder.trim() !== '' && folderProblem !== undefined && <div className="rename-status is-invalid">{translateDescribed(folderProblem)}</div>}
              </>
            )}
            <div className="rename-path">
              <span>{translate('palette.rename.path')}</span>
              <code>{previewPath(availability, chosenFolder, props.file)}</code>
            </div>
            <PreviewSummary preview={preview} active={request !== undefined} />
          </div>
          <div className="modal-footer">
            <button onClick={close}>{translate('ui.cancel')}</button>
            <button className="primary" disabled={!ready} onClick={submit}>
              {translate(change === 'rename' ? 'palette.rename.submitRename' : change === 'move' ? 'palette.rename.submitMove' : 'palette.rename.submitBoth')}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}

function baseOf(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1).replace(/\.astro$/, '');
}

// The last level of every folder below a root, for telling whether the project writes its folders in PascalCase or lowercase.
function folderLevels(folders: readonly string[], roots: readonly string[]): readonly string[] {
  return folders.filter((folder) => !roots.includes(folder)).map((folder) => folder.slice(folder.lastIndexOf('/') + 1));
}

function previewPath(availability: ReturnType<typeof renameAvailability>, folder: string, current: string): string {
  if (availability.kind === 'same') {
    return current;
  }
  return availability.path ?? `${folder}/…`;
}

// Every folder a component can go in: the roots, each folder holding a component, and the ancestors between, never above a root.
function folderChoices(roots: readonly string[], components: readonly RenameCandidate[], current: string): readonly string[] {
  const found = new Set<string>([...roots, current]);
  for (const component of components) {
    const directory = component.file.slice(0, component.file.lastIndexOf('/'));
    const root = roots.find((candidate) => directory === candidate || directory.startsWith(`${candidate}/`));
    if (root === undefined) {
      continue;
    }
    const segments = directory
      .slice(root.length + 1)
      .split('/')
      .filter((segment) => segment !== '');
    for (let depth = 0; depth <= segments.length; depth += 1) {
      found.add([root, ...segments.slice(0, depth)].join('/'));
    }
  }
  return [...found].sort((left, right) => left.localeCompare(right));
}

// Main's list of what would change, asked after typing pauses and dropped if the name changed meanwhile.
function usePreview(request: ComponentRenameRequest | undefined, plan: RenameComponentDialogProps['plan']): Preview {
  const [preview, setPreview] = useState<Preview>({ kind: 'idle' });
  const from = request?.from;
  const to = request?.to;
  useEffect(() => {
    if (from === undefined || to === undefined) {
      setPreview({ kind: 'idle' });
      return undefined;
    }
    let current = true;
    setPreview({ kind: 'loading' });
    const timer = setTimeout(() => {
      void plan({ from, to }).then(
        (result) => {
          if (current) {
            setPreview(result.ok ? { kind: 'ready', summary: result.value } : { kind: 'error', message: result.error.message });
          }
        },
        (error: unknown) => {
          if (current) {
            setPreview({ kind: 'error', message: String(error) });
          }
        },
      );
    }, RENAME_PREVIEW_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [from, to, plan]);
  return preview;
}

function PreviewSummary({ preview, active }: { readonly preview: Preview; readonly active: boolean }) {
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  if (!active || preview.kind === 'idle') {
    return undefined;
  }
  if (preview.kind === 'loading') {
    return <div className="rename-files panel-loading-label">{translate('palette.rename.checking')}</div>;
  }
  if (preview.kind === 'error') {
    return <div className="rename-status is-invalid">{preview.message}</div>;
  }
  const { files, notices } = preview.summary;
  return (
    <div className="rename-files">
      <button type="button" className="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {files.length === 0 ? translate('palette.rename.onlyFile') : translate('palette.rename.files', { count: files.length })}
        {files.length > 0 && ` · ${translate(open ? 'palette.rename.hideFiles' : 'palette.rename.showFiles')}`}
      </button>
      {open && (
        <ul className="rename-file-list">
          {files.map((entry) => (
            <li key={entry.file}>
              <code>{entry.file}</code>
            </li>
          ))}
        </ul>
      )}
      {notices.length > 0 && (
        <div className="rename-notices">
          <div className="rename-notices-title">{translate('palette.rename.notices')}</div>
          <ul className="rename-file-list">
            {notices.map((notice) => (
              <li key={`${notice.file}:${notice.kind}`}>{translate(NOTICE_KEYS[notice.kind], { file: notice.file })}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
