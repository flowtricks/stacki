// Settings → Folders, the CMS section: which content collections and data
// files the CMS panel lists, saved under `cms` in `.stacki/folders.json`.
// Collections come from the content config, as they always have; each can be
// hidden from the panel. Data files are found automatically until the project
// names them: the first add or remove starts from what was found, and "Reset to
// default" returns to automatic detection. Every data file, each of its
// exports and every collection can also be left out of the binding picker
// (`cms.pickerExcluded`); that hides it from the picker only, never from the
// CMS panel.
import React, { useEffect, useState } from 'react';
import { CodeInline } from '../../ui/CodeBlock';
import { BracesIcon, CloseIcon, CmsIcon, PlusIcon } from '../../ui/Icons';
import { cleanError } from '../../lib/cleanError';
import { assert } from '../../../shared/core/assert';
import {
  addCmsFile,
  cmsDataFiles,
  cmsFilesFor,
  isCollectionHidden,
  isPickerShown,
  removeCmsFile,
  withPickerShown,
  type PickerExclusion,
  withCmsFiles,
  withCollectionShown,
  type ProjectFolders,
} from '../../../shared/properties/projectFolders';
import { readCmsFiles, readContentCollections } from '../../features/cms/cmsPanelBridge';
import { pickProjectPath } from './foldersBridge';
import { Switch } from '../../ui/Switch';
import { FolderTitle } from './FolderSettings';
import { dataFileExports, type DataFileExport } from '../../features/props/projectDataSources';

/** What the CMS reads now: the content config's collections and the data files the panel found. */
type Sources =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly collections: readonly string[];
      readonly configPath: string | undefined;
      readonly detected: readonly string[];
      readonly exports: readonly DataFileExport[];
    };

/** The project files behind the CMS panel's entries: `consts.ts#*general` is `src/consts.ts`. */
export function cmsEntryFiles(rels: readonly string[]): readonly string[] {
  const files = [...new Set(rels.map((rel) => 'src/' + (rel.split('#')[0] ?? rel)))];
  assert(
    files.every((file) => file.startsWith('src/')),
    'cmsEntryFiles: entries are under src/',
  );
  return files.sort();
}

export function CmsSources(props: {
  readonly projectPath: string;
  readonly config: ProjectFolders | undefined;
  readonly busy: boolean;
  readonly onSave: (next: ProjectFolders) => void;
  readonly onNotice: (message: string | undefined) => void;
  readonly onOpenFile?: (rel: string) => void;
}) {
  const [sources, setSources] = useState<Sources>({ kind: 'loading' });
  // Detection only changes with the project, never with these settings: once a
  // list is chosen, the panel reads the chosen files instead.
  useEffect(() => {
    let active = true;
    void Promise.all([readContentCollections(props.projectPath), readCmsFiles(props.projectPath)]).then(([content, files]) => {
      if (!active) {
        return;
      }
      if (!content.ok) {
        setSources({ kind: 'failed', message: content.error });
        return;
      }
      if (!files.ok) {
        setSources({ kind: 'failed', message: files.error });
        return;
      }
      setSources({
        kind: 'ready',
        collections: content.value.collections.map((collection) => collection.name),
        configPath: content.value.configPath,
        detected: cmsEntryFiles(files.value.map((file) => file.rel)),
        exports: dataFileExports(files.value),
      });
    });
    return () => {
      active = false;
    };
  }, [props.projectPath]);

  if (sources.kind === 'loading') {
    return (
      <p className="app-settings-status" role="status">
        Loading CMS sources…
      </p>
    );
  }
  if (sources.kind === 'failed') {
    return (
      <p className="app-folders-notice" role="alert">
        {sources.message}
      </p>
    );
  }
  const chosen = cmsFilesFor(props.config);
  // Astro files are always sources and never listed here (isAstroSource).
  const files = cmsDataFiles(props.config, sources.detected);
  const open = props.onOpenFile;
  const configPath = sources.configPath;
  const addFile = async (): Promise<void> => {
    props.onNotice(undefined);
    let picked;
    try {
      picked = await pickProjectPath(props.projectPath, 'file');
    } catch (failure: unknown) {
      props.onNotice(cleanError(failure));
      return;
    }
    switch (picked.kind) {
      case 'canceled':
        return;
      case 'outside':
        props.onNotice(picked.message);
        return;
      case 'picked': {
        const next = addCmsFile(props.config, picked.path, sources.detected);
        if (next.ok) {
          props.onSave(next.value);
        } else {
          props.onNotice(next.error);
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
    <>
      <div className="app-folder-row" aria-label="CMS collections">
        <div className="app-folder-heading">
          <CmsIcon size={14} />
          <span className="app-folder-title">CMS collections</span>
        </div>
        {sources.collections.length === 0 && <p className="app-folder-fixed">The content config declares no collections.</p>}
        <ul className="app-folder-toggles">
          {sources.collections.map((name) => {
            const shown = !isCollectionHidden(props.config, name);
            return (
              <li key={name} className="app-folder-toggle">
                <CodeInline text={name} />
                <Switch
                  label={`Show ${name} in the CMS panel`}
                  checked={shown}
                  disabled={props.busy}
                  onToggle={() => props.onSave(withCollectionShown(props.config, name, { shown: !shown }))}
                />
              </li>
            );
          })}
        </ul>
        <p className="app-folder-fixed">
          Read from the content config, where Astro looks for them.
          {configPath !== undefined && open !== undefined && (
            <>
              {' '}
              <button type="button" className="app-folder-link" onClick={() => open(configPath)}>
                Open content config
              </button>
            </>
          )}
        </p>
      </div>
      <div className="app-folder-row" aria-label="CMS data files">
        <div className="app-folder-heading">
          <CmsIcon size={14} />
          <FolderTitle
            label="CMS data files"
            customized={chosen !== undefined}
            busy={props.busy}
            onReset={() => props.onSave(withCmsFiles(props.config, undefined))}
          />
          <div className="app-folder-actions">
            <button type="button" disabled={props.busy} onClick={() => void addFile()} title="A .ts, .js, .json or .astro file under src/">
              <PlusIcon size={12} />
              <span>Add file</span>
            </button>
          </div>
        </div>
        <ul className="app-folder-list">
          {files.map((file) => (
            <li key={file} className="app-folder-chip">
              <CodeInline text={file} />
              <button
                type="button"
                aria-label={`Remove ${file} from CMS data files`}
                disabled={props.busy}
                onClick={() => props.onSave(removeCmsFile(props.config, file, sources.detected))}
              >
                <CloseIcon size={12} />
              </button>
            </li>
          ))}
          {files.length === 0 && <li className="app-folder-none">No data files: the CMS panel lists only collections.</li>}
        </ul>
      </div>
      <PickerSources
        collections={sources.collections}
        exports={sources.exports}
        config={props.config}
        busy={props.busy}
        onSave={props.onSave}
        onNotice={props.onNotice}
      />
    </>
  );
}

/** A data file's exports, in the order the CMS read them, by file. */
export function exportsByFile(exports: readonly DataFileExport[]): ReadonlyArray<readonly [string, readonly string[]]> {
  const byFile = new Map<string, string[]>();
  for (const item of exports) {
    const names = byFile.get(item.file);
    if (names === undefined) {
      byFile.set(item.file, [item.exported]);
    } else {
      names.push(item.exported);
    }
  }
  const out = [...byFile];
  assert(out.reduce((total, [, names]) => total + names.length, 0) === exports.length, 'exportsByFile: every export is kept once');
  return out;
}

// What the binding picker lists beyond the open file's own data: each data
// file, each of its exports beneath it, and each collection, all shown until
// switched off. An export of a file that is switched off stays off with it.
function PickerSources(props: {
  readonly collections: readonly string[];
  readonly exports: readonly DataFileExport[];
  readonly config: ProjectFolders | undefined;
  readonly busy: boolean;
  readonly onSave: (next: ProjectFolders) => void;
  readonly onNotice: (message: string | undefined) => void;
}) {
  const toggle = (source: PickerExclusion, now: { readonly shown: boolean }): void => {
    props.onNotice(undefined);
    try {
      props.onSave(withPickerShown(props.config, source, { shown: !now.shown }));
    } catch (failure: unknown) {
      props.onNotice(cleanError(failure));
    }
  };
  const files = exportsByFile(props.exports);
  const empty = files.length === 0 && props.collections.length === 0;
  return (
    <div className="app-folder-row" aria-label="Data picker sources">
      <div className="app-folder-heading">
        <BracesIcon size={14} />
        <span className="app-folder-title">Data picker</span>
      </div>
      {empty && <p className="app-folder-fixed">No data files or collections to bind to.</p>}
      <ul className="app-folder-toggles">
        {files.map(([file, names]) => {
          const fileShown = isPickerShown(props.config, { kind: 'file', file });
          return (
            <React.Fragment key={file}>
              <PickerToggle text={file} shown={fileShown} busy={props.busy} onToggle={() => toggle({ kind: 'file', file }, { shown: fileShown })} />
              {names.map((exported) => {
                const source: PickerExclusion = { kind: 'export', file, exported };
                const shown = isPickerShown(props.config, source);
                return (
                  <PickerToggle
                    key={`${file}#${exported}`}
                    text={exported}
                    nested
                    shown={shown}
                    busy={props.busy || !fileShown}
                    onToggle={() => toggle(source, { shown })}
                  />
                );
              })}
            </React.Fragment>
          );
        })}
        {props.collections.map((name) => {
          const shown = isPickerShown(props.config, { kind: 'collection', name });
          return <PickerToggle key={name} text={name} shown={shown} busy={props.busy} onToggle={() => toggle({ kind: 'collection', name }, { shown })} />;
        })}
      </ul>
      <p className="app-folder-fixed">Switched off, a source leaves the binding picker only; the CMS panel still lists it.</p>
    </div>
  );
}

function PickerToggle(props: {
  readonly text: string;
  readonly nested?: boolean;
  readonly shown: boolean;
  readonly busy: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <li className={props.nested === true ? 'app-folder-toggle is-nested' : 'app-folder-toggle'}>
      <CodeInline text={props.text} />
      <Switch label={`Show ${props.text} in data picker`} checked={props.shown} disabled={props.busy} onToggle={props.onToggle} />
    </li>
  );
}
