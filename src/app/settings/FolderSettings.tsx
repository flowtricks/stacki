// Settings → Folders: which project folders each panel reads, saved in
// `.stacki/folders.json` so Desktop and Studio read the same ones. A panel the
// project never changed shows its defaults and writes nothing; the first add,
// remove or reset creates the file. Pages are shown but fixed: they follow
// `srcDir` in astro.config, where Astro routes from. The CMS section
// (CmsSourceSettings.tsx) hides collections and chooses data files.
import { useEffect, useState, type ReactNode } from 'react';
import { CodeInline } from '../../ui/CodeBlock';
import { CloseIcon, LayoutIcon, PlusIcon } from '../../ui/Icons';
import { ResetLabel } from '../../ui/ResetLabel';
import { FeatureIcon } from '../featureIcons';
import { cleanError } from '../../lib/cleanError';
import { assert } from '../../../shared/core/assert';
import {
  PAGES_FOLDER,
  PROJECT_FOLDER_KINDS,
  PROJECT_FOLDER_ROOTS,
  addFolder,
  configOf,
  foldersFor,
  differsFromDefaults,
  removeFolder,
  withFolders,
  type ProjectFolderKind,
  type ProjectFolders,
} from '../../../shared/properties/projectFolders';
import { pickProjectPath, readFoldersFile, saveFoldersFile, type FoldersFile } from './foldersBridge';
import { notifyProjectSourcesChanged } from '../state/projectSources';
import { CmsSources } from './CmsSourceSettings';
import { SettingsIntro, SettingsSection, useSaveIndicator } from './SettingsLayout';

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  // The host predates folder settings: the defaults it scans with show, read-only.
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'ready'; readonly file: FoldersFile };

const KIND_LABELS: Readonly<Record<ProjectFolderKind, string>> = {
  components: 'Components',
  layouts: 'Layouts',
  assets: 'Assets',
  styles: 'Styles',
  variables: 'Variables',
};

// Each kind shows the icon of the panel that reads it (featureIcons.ts); layouts have no panel.
function KindIcon(props: { readonly kind: ProjectFolderKind }) {
  switch (props.kind) {
    case 'components':
      return <FeatureIcon feature="panel:components" size={14} />;
    case 'layouts':
      return <LayoutIcon size={14} />;
    case 'assets':
      return <FeatureIcon feature="panel:assets" size={14} />;
    case 'styles':
      return <FeatureIcon feature="panel:selectors" size={14} />;
    case 'variables':
      return <FeatureIcon feature="panel:variables" size={14} />;
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
}

/** Desktop's note for a main process older than this renderer; Studio passes its own. */
const UNSUPPORTED_NOTE = 'Restart Stacki to edit folders.';

export interface FolderSettingsProps {
  readonly projectPath: string;
  /** What the tab says when the host predates folder settings. */
  readonly unsupportedNote?: string;
  /** Where Astro reads pages (the scan's `pagesFolder`), and the astro.config that says so. */
  readonly pages?: { readonly folder: string; readonly configFile: string | undefined };
  /** Opens a project file in the code panel; the tab's "Open …" links need it. */
  readonly onOpenFile?: (rel: string) => void;
}

export function FolderSettings(props: FolderSettingsProps) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const indicator = useSaveIndicator();
  useEffect(() => {
    let active = true;
    void readFoldersFile(props.projectPath).then(
      (answer) => {
        if (active) {
          setLoad(answer.kind === 'file' ? { kind: 'ready', file: answer.file } : { kind: 'unsupported' });
        }
      },
      (failure: unknown) => {
        if (active) {
          setLoad({ kind: 'failed', message: cleanError(failure) });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [props.projectPath]);

  if (load.kind === 'loading') {
    return (
      <p className="app-settings-status" role="status">
        Loading folders…
      </p>
    );
  }
  if (load.kind === 'failed') {
    return (
      <p className="app-folders-notice" role="alert">
        {load.message}
      </p>
    );
  }
  if (load.kind === 'unsupported') {
    return <UnsupportedFolders note={props.unsupportedNote ?? UNSUPPORTED_NOTE} pagesRow={<PagesRow {...props} />} />;
  }
  const file = load.file;
  const config = configOf(file.read);

  const save = async (next: ProjectFolders): Promise<void> => {
    setBusy(true);
    setNotice(undefined);
    try {
      setLoad({ kind: 'ready', file: await indicator.track(saveFoldersFile(props.projectPath, file.source, next)) });
      // An open binding picker re-reads what it may list (Show in data picker).
      notifyProjectSourcesChanged();
    } catch (failure: unknown) {
      setNotice(cleanError(failure));
    } finally {
      setBusy(false);
    }
  };
  const add = async (kind: ProjectFolderKind): Promise<void> => {
    setNotice(undefined);
    let picked;
    try {
      picked = await pickProjectPath(props.projectPath);
    } catch (failure: unknown) {
      setNotice(cleanError(failure));
      return;
    }
    switch (picked.kind) {
      case 'canceled':
        return;
      case 'outside':
        setNotice(picked.message);
        return;
      case 'picked': {
        const next = addFolder(config, kind, picked.path);
        if (next.ok) {
          await save(next.value);
        } else {
          setNotice(next.error);
        }
        return;
      }
      default: {
        const exhaustive: never = picked;
        return exhaustive;
      }
    }
  };

  return (
    <section className="app-folders" aria-label="Project folders">
      <SettingsIntro saving={indicator.state}>
        The folders each panel reads, saved in <CodeInline text=".stacki/folders.json" /> for Desktop and Studio. A panel you have not changed uses its
        defaults. Changes save as you make them.
      </SettingsIntro>
      {file.read.kind === 'invalid' && (
        <p className="app-folders-notice" role="alert">
          The folder settings could not be read ({file.read.message}). Every panel uses its defaults; a change here replaces the file.
        </p>
      )}
      {notice !== undefined && (
        <p className="app-folders-notice" role="alert">
          {notice}
        </p>
      )}
      <SettingsSection title="Panels">
        {PROJECT_FOLDER_KINDS.map((kind) => (
          <FolderRow
            key={kind}
            kind={kind}
            folders={foldersFor(kind, config)}
            customized={differsFromDefaults(kind, config)}
            busy={busy}
            onAdd={() => void add(kind)}
            onRemove={(folder) => void save(removeFolder(config, kind, folder))}
            onReset={() => void save(withFolders(config, kind, undefined))}
          />
        ))}
        <PagesRow {...props} />
      </SettingsSection>
      <SettingsSection title="CMS" description="Which collections and data files the CMS panel lists.">
        <CmsSources
          projectPath={props.projectPath}
          config={config}
          busy={busy}
          onSave={(next) => void save(next)}
          onNotice={setNotice}
          {...(props.onOpenFile === undefined ? {} : { onOpenFile: props.onOpenFile })}
        />
      </SettingsSection>
    </section>
  );
}

/** The defaults every panel reads, shown without controls: the host cannot store a change. */
function UnsupportedFolders(props: { readonly note: string; readonly pagesRow: ReactNode }) {
  return (
    <section className="app-folders" aria-label="Project folders">
      <p className="app-folders-notice" role="status">
        {props.note}
      </p>
      <SettingsSection title="Panels">
        {PROJECT_FOLDER_KINDS.map((kind) => (
          <FixedRow key={kind} icon={<KindIcon kind={kind} />} label={KIND_LABELS[kind]} folders={foldersFor(kind, undefined)}>
            Default folders.
          </FixedRow>
        ))}
        {props.pagesRow}
      </SettingsSection>
    </section>
  );
}

/** Pages follow Astro's own setting: `<srcDir>/pages`, read from astro.config, never edited here. */
function PagesRow(props: FolderSettingsProps) {
  const folder = props.pages?.folder ?? PAGES_FOLDER;
  const configFile = props.pages?.configFile;
  const open = props.onOpenFile;
  return (
    <FixedRow icon={<FeatureIcon feature="panel:pages" size={14} />} label="Pages" folders={[folder]}>
      Follows <CodeInline text="srcDir" /> in astro.config.
      {configFile !== undefined && open !== undefined && (
        <>
          {' '}
          <button type="button" className="app-folder-link" onClick={() => open(configFile)}>
            Open astro.config
          </button>
        </>
      )}
    </FixedRow>
  );
}

function FolderRow(props: {
  readonly kind: ProjectFolderKind;
  readonly folders: readonly string[];
  readonly customized: boolean;
  readonly busy: boolean;
  readonly onAdd: () => void;
  readonly onRemove: (folder: string) => void;
  readonly onReset: () => void;
}) {
  assert(props.customized || props.folders.length > 0, 'FolderRow: a default list is never empty');
  const label = KIND_LABELS[props.kind];
  const roots = PROJECT_FOLDER_ROOTS[props.kind].map((root) => root + '/').join(', ');
  return (
    <div className="app-folder-row" aria-label={`${label} folders`}>
      <div className="app-folder-heading">
        <KindIcon kind={props.kind} />
        <FolderTitle label={label} customized={props.customized} busy={props.busy} onReset={props.onReset} />
        <div className="app-folder-actions">
          <button type="button" disabled={props.busy} onClick={props.onAdd} title={`A folder inside ${roots}`}>
            <PlusIcon size={12} />
            <span>Add folder</span>
          </button>
        </div>
      </div>
      <ul className="app-folder-list">
        {props.folders.map((folder) => (
          <li key={folder} className="app-folder-chip">
            <CodeInline text={folder} />
            <button type="button" aria-label={`Remove ${folder} from ${label}`} disabled={props.busy} onClick={() => props.onRemove(folder)}>
              <CloseIcon size={12} />
            </button>
          </li>
        ))}
        {props.folders.length === 0 && <li className="app-folder-none">No folders: this panel lists nothing.</li>}
      </ul>
    </div>
  );
}

/**
 * A row's title. At its defaults it is plain; once changed it is the app's blue
 * set label (ResetLabel, as CMS filters and style properties use), and clicking
 * it offers "Reset to default". The colour alone says the row was changed.
 */
export function FolderTitle(props: { readonly label: string; readonly customized: boolean; readonly busy: boolean; readonly onReset: () => void }) {
  return (
    <span className="app-folder-title">
      <ResetLabel
        label={props.label}
        active={props.customized}
        onReset={() => {
          // A reset during a save would write over it from a stale base; the save's own result shows next.
          if (!props.busy) {
            props.onReset();
          }
        }}
      />
    </span>
  );
}

function FixedRow(props: { readonly icon: ReactNode; readonly label: string; readonly folders: readonly string[]; readonly children: ReactNode }) {
  return (
    <div className="app-folder-row" aria-label={`${props.label} folders`}>
      <div className="app-folder-heading">
        {props.icon}
        <span className="app-folder-title">{props.label}</span>
      </div>
      {props.folders.length > 0 && (
        <ul className="app-folder-list">
          {props.folders.map((folder) => (
            <li key={folder} className="app-folder-chip">
              <CodeInline text={folder} />
            </li>
          ))}
        </ul>
      )}
      <p className="app-folder-fixed">{props.children}</p>
    </div>
  );
}
