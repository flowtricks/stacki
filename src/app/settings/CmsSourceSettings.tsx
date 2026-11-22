// Settings → Folders, the CMS section: which content collections and data
// files the CMS panel lists, saved under `cms` in `.stacki/folders.json`.
// Collections come from the content config, as they always have; each can be
// hidden from the panel. Data files are found automatically until the project
// names them: the first add or remove starts from what was found, and "Reset to
// default" returns to automatic detection. Every data file, each of its
// exports and every collection can also be left out of the binding picker
// (`cms.pickerExcluded`); that hides it from the picker only, never from the
// CMS panel.
import React, { useEffect, useState, type ReactNode } from 'react';
import { CodeInline } from '../../ui/CodeBlock';
import { BracesIcon, ChevronRightIcon, CloseIcon, CmsIcon, FileIcon, PlusIcon } from '../../ui/Icons';
import { cleanError } from '../../lib/cleanError';
import { assert } from '../../../shared/core/assert';
import {
  addCmsFileDescribed,
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
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Described } from '../../../shared/properties/i18n/messageRef';
import InfoHint from '../../ui/InfoHint';
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
  readonly onNotice: (notice: Described | undefined) => void;
  readonly onOpenFile?: (rel: string) => void;
}) {
  const translate = useTranslate();
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
        {translate('settings.folders.cms.loading')}
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
      props.onNotice({ message: cleanError(failure) });
      return;
    }
    switch (picked.kind) {
      case 'canceled':
        return;
      case 'outside':
        props.onNotice({ message: picked.message });
        return;
      case 'picked': {
        const next = addCmsFileDescribed(props.config, picked.path, sources.detected);
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
      <div className="app-folder-row" aria-label={translate('settings.folders.cms.collections')}>
        <div className="app-folder-heading">
          <CmsIcon size={14} />
          <span className="app-folder-title">
            {translate('settings.folders.cms.collections')}
            <InfoHint text={translate('settings.folders.collections.info')} />
          </span>
        </div>
        {sources.collections.length === 0 && <p className="app-folder-fixed">{translate('settings.folders.cms.collectionsNone')}</p>}
        <ul className="app-folder-toggles">
          {sources.collections.map((name) => {
            const shown = !isCollectionHidden(props.config, name);
            return (
              <li key={name} className="app-folder-toggle app-folder-collection">
                <span className="app-folder-collection-icon">
                  <CmsIcon size={14} />
                </span>
                <CodeInline text={name} />
                <Switch
                  label={translate('settings.folders.cms.showCollection', { name })}
                  checked={shown}
                  disabled={props.busy}
                  onToggle={() => props.onSave(withCollectionShown(props.config, name, { shown: !shown }))}
                />
              </li>
            );
          })}
        </ul>
        {configPath !== undefined && open !== undefined && (
          <button type="button" className="app-folder-config-button" onClick={() => open(configPath)}>
            <BracesIcon size={12} />
            <span>{translate('settings.folders.cms.openConfig')}</span>
          </button>
        )}
      </div>
      <div className="app-folder-row" aria-label={translate('settings.folders.cms.dataFiles')}>
        <div className="app-folder-heading">
          <CmsIcon size={14} />
          <FolderTitle
            label={translate('settings.folders.cms.dataFiles')}
            customized={chosen !== undefined}
            busy={props.busy}
            onReset={() => props.onSave(withCmsFiles(props.config, undefined))}
          />
          <div className="app-folder-actions">
            <button type="button" disabled={props.busy} onClick={() => void addFile()} title={translate('settings.folders.cms.addFileTip')}>
              <PlusIcon size={12} />
              <span>{translate('settings.folders.cms.addFile')}</span>
            </button>
          </div>
        </div>
        <ul className="app-folder-list">
          {files.map((file) => (
            <li key={file} className="app-folder-chip">
              <CodeInline text={file} />
              <button
                type="button"
                aria-label={translate('settings.folders.cms.removeFile', { file })}
                disabled={props.busy}
                onClick={() => props.onSave(removeCmsFile(props.config, file, sources.detected))}
              >
                <CloseIcon size={12} />
              </button>
            </li>
          ))}
          {files.length === 0 && <li className="app-folder-none">{translate('settings.folders.cms.noFiles')}</li>}
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
export function PickerSources(props: {
  readonly collections: readonly string[];
  readonly exports: readonly DataFileExport[];
  readonly config: ProjectFolders | undefined;
  readonly busy: boolean;
  readonly onSave: (next: ProjectFolders) => void;
  readonly onNotice: (notice: Described | undefined) => void;
}) {
  const translate = useTranslate();
  const toggle = (source: PickerExclusion, now: { readonly shown: boolean }): void => {
    props.onNotice(undefined);
    try {
      props.onSave(withPickerShown(props.config, source, { shown: !now.shown }));
    } catch (failure: unknown) {
      props.onNotice({ message: cleanError(failure) });
    }
  };
  const files = exportsByFile(props.exports);
  const empty = files.length === 0 && props.collections.length === 0;
  return (
    <div className="app-folder-row" aria-label={translate('settings.folders.cms.pickerAria')}>
      <div className="app-folder-heading">
        <BracesIcon size={14} />
        <span className="app-folder-title">
          {translate('settings.folders.cms.picker')}
          <InfoHint text={translate('settings.folders.picker.info')} />
        </span>
      </div>
      {empty && <p className="app-folder-fixed">{translate('settings.folders.cms.pickerNone')}</p>}
      <ul className="app-folder-toggles">
        {files.map(([file, names]) => {
          const fileShown = isPickerShown(props.config, { kind: 'file', file });
          if (names.length === 0) {
            return (
              <PickerToggle
                key={file}
                text={file}
                icon={<FileIcon size={14} />}
                shown={fileShown}
                busy={props.busy}
                onToggle={() => toggle({ kind: 'file', file }, { shown: fileShown })}
              />
            );
          }
          return (
            <PickerFileGroup
              key={file}
              file={file}
              names={names}
              fileShown={fileShown}
              busy={props.busy}
              isExportShown={(exported) => isPickerShown(props.config, { kind: 'export', file, exported })}
              onToggleFile={() => toggle({ kind: 'file', file }, { shown: fileShown })}
              onToggleExport={(exported, shown) => toggle({ kind: 'export', file, exported }, { shown })}
            />
          );
        })}
        {props.collections.map((name) => {
          const shown = isPickerShown(props.config, { kind: 'collection', name });
          return (
            <PickerToggle
              key={name}
              text={name}
              icon={<CmsIcon size={14} />}
              shown={shown}
              busy={props.busy}
              onToggle={() => toggle({ kind: 'collection', name }, { shown })}
            />
          );
        })}
      </ul>
    </div>
  );
}

// One data file in the picker list: collapsed until opened, so a long list of
// files stays scannable. It follows the Audits sections (AuditsSettings.tsx):
// chevron, file name and a "3 of 5" count in one button, the file's own switch
// at the end, the exports below. Open state is per-session UI state, like theirs.
function PickerFileGroup(props: {
  readonly file: string;
  readonly names: readonly string[];
  readonly fileShown: boolean;
  readonly busy: boolean;
  readonly isExportShown: (exported: string) => boolean;
  readonly onToggleFile: () => void;
  readonly onToggleExport: (exported: string, shown: boolean) => void;
}) {
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  // An export of a switched-off file stays off with it, so it does not count.
  const shownCount = props.fileShown ? props.names.filter((exported) => props.isExportShown(exported)).length : 0;
  assert(shownCount <= props.names.length, 'PickerFileGroup: the shown count never exceeds the exports');
  return (
    <li className="app-folder-group" data-open={open ? 'true' : 'false'}>
      <div className="app-folder-group-heading">
        <button type="button" className="app-folder-group-disclosure" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          <ChevronRightIcon size={12} />
          <span className="app-folder-row-icon">
            <FileIcon size={14} />
          </span>
          <CodeInline text={props.file} />
          <span className="app-folder-group-summary">{translate('settings.roles.summary.ofTotal', { count: shownCount, total: props.names.length })}</span>
        </button>
        <Switch
          label={translate('settings.folders.cms.showInPicker', { name: props.file })}
          checked={props.fileShown}
          disabled={props.busy}
          onToggle={props.onToggleFile}
        />
      </div>
      {open && (
        <ul className="app-folder-toggles app-folder-group-body">
          {props.names.map((exported) => (
            <PickerToggle
              key={`${props.file}#${exported}`}
              text={exported}
              nested
              shown={props.isExportShown(exported)}
              busy={props.busy || !props.fileShown}
              onToggle={() => props.onToggleExport(exported, props.isExportShown(exported))}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function PickerToggle(props: {
  readonly text: string;
  /** The row's icon, in the same column as a data file's icon; absent for an export, which sits under its file. */
  readonly icon?: ReactNode;
  readonly nested?: boolean;
  readonly shown: boolean;
  readonly busy: boolean;
  readonly onToggle: () => void;
}) {
  const translate = useTranslate();
  return (
    <li className={props.nested === true ? 'app-folder-toggle is-nested' : 'app-folder-toggle is-top-level'}>
      {props.icon !== undefined && <span className="app-folder-row-icon">{props.icon}</span>}
      <CodeInline text={props.text} />
      <Switch
        label={translate('settings.folders.cms.showInPicker', { name: props.text })}
        checked={props.shown}
        disabled={props.busy}
        onToggle={props.onToggle}
      />
    </li>
  );
}
