// The project data the binding picker offers beyond what the open file reads:
// every data file export the CMS panel knows, and the project's collections,
// less what the project left out of the picker (Settings → Folders,
// `cms.pickerExcluded`). Shared by Desktop (App.tsx) and Studio
// (studio bindContext.ts): each host passes its own way of resolving an import
// specifier, and both read the catalog and the folder settings through the
// same bridges.
//
// The catalog is read once per project and again whenever the CMS says its
// files changed or the Folders tab saved; the `@/` alias is probed once per
// project and file, by asking the host's resolver where `@/consts` lands.

import { useEffect, useMemo, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { isPickerShown, type ProjectFolders } from '../../../shared/properties/projectFolders';
import { readCmsFiles, readContentCollections } from '../../features/cms/cmsPanelBridge';
import { readContentEntries } from '../../features/content/contentViewBridge';
import { readProjectFolderSettings } from '../../ipc/projectFolderSettings';
import { cmsTransport } from '../../ipc/editorEnvironment';
import type { ImportLike } from '../../editor/dataSource';
import { entrySampleKey, type TreeNode } from '../../editor/dataSample';
import { aliasProbeFor, dataFileExports, projectSourceNodes, type DataFileExport, type ImportStyle } from '../../features/props/projectDataSources';

/** Fired after the Folders tab saves, so an open picker re-reads what it may list. */
export const PROJECT_SOURCES_CHANGED = 'stacki:project-sources-changed';

export function notifyProjectSourcesChanged(): void {
  window.dispatchEvent(new Event(PROJECT_SOURCES_CHANGED));
}

export interface ProjectSourcesHost {
  readonly projectPath: string | undefined;
  /** The file being bound, project-relative: `src/pages/index.astro`. */
  readonly file: string | undefined;
  readonly frontmatter: string;
  readonly imports: readonly ImportLike[];
  /** Where `spec`, imported from the file being bound, lands: a project-relative path, or undefined. */
  readonly resolveSpec: (spec: string) => Promise<string | undefined>;
}

export interface ProjectSources {
  /** The picker's roots for data file exports, each carrying the import a pick writes. */
  readonly nodes: readonly TreeNode[];
  /** The folder settings read with them, for leaving collections out (shownPickerCollections). */
  readonly config: ProjectFolders | undefined;
}

interface Catalog {
  readonly key: string;
  readonly exports: readonly DataFileExport[];
  readonly config: ProjectFolders | undefined;
}

const NO_EXPORTS: readonly DataFileExport[] = [];

export function useProjectSources(host: ProjectSourcesHost): ProjectSources {
  const catalog = useCatalog(host.projectPath);
  const style = useImportStyle(host, catalog?.exports ?? NO_EXPORTS);
  const { file, frontmatter, imports } = host;
  const exports = catalog?.exports ?? NO_EXPORTS;
  const config = catalog?.config;
  const nodes = useMemo(() => projectSourceNodes({ exports, config, style, file, frontmatter, imports }), [exports, config, style, file, frontmatter, imports]);
  return { nodes, config };
}

/** The collections the picker lists: every one but those the project left out of it. */
export function shownPickerCollections<T extends { readonly name: string }>(collections: readonly T[], config: ProjectFolders | undefined): readonly T[] {
  const shown = collections.filter((collection) => isPickerShown(config, { kind: 'collection', name: collection.name }));
  assert(shown.length <= collections.length, 'shownPickerCollections: leaving out only removes');
  return shown;
}

// The CMS catalog's exports and the folder settings, for one project.
function useCatalog(projectPath: string | undefined): Catalog | undefined {
  const [catalog, setCatalog] = useState<Catalog | undefined>(undefined);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = (): void => setVersion((current) => current + 1);
    const stopCms = cmsTransport.onCmsChanged(bump);
    window.addEventListener(PROJECT_SOURCES_CHANGED, bump);
    return () => {
      stopCms();
      window.removeEventListener(PROJECT_SOURCES_CHANGED, bump);
    };
  }, []);
  useEffect(() => {
    if (projectPath === undefined || projectPath === '') {
      return undefined;
    }
    let live = true;
    // A catalog or settings that cannot be read lists no data files and leaves nothing out:
    // the picker then offers what is in scope, as it did before.
    const settings = readProjectFolderSettings(projectPath).catch((): undefined => undefined);
    const catalog = readCmsFiles(projectPath)
      .then((files) => (files.ok ? dataFileExports(files.value) : NO_EXPORTS))
      .catch(() => NO_EXPORTS);
    void Promise.all([catalog, settings]).then(([exports, config]) => {
      if (live) {
        setCatalog({ key: projectPath, exports, config });
      }
    });
    return () => {
      live = false;
    };
  }, [projectPath, version]);
  return catalog?.key === projectPath ? catalog : undefined;
}

// Whether imports from the file being bound go through the `@/` alias: asked
// of the host's resolver with the first data file, once per project and file.
function useImportStyle(host: ProjectSourcesHost, exports: readonly DataFileExport[]): ImportStyle {
  const target = exports[0]?.file;
  const probe = target === undefined ? undefined : aliasProbeFor(target);
  const key = JSON.stringify([host.projectPath ?? '', host.file ?? '', probe ?? '']);
  const [answer, setAnswer] = useState<{ readonly key: string; readonly style: ImportStyle } | undefined>(undefined);
  const { resolveSpec } = host;
  useEffect(() => {
    if (probe === undefined || target === undefined || host.file === undefined) {
      return undefined;
    }
    let live = true;
    void resolveSpec(probe)
      .catch((): undefined => undefined)
      .then((resolved) => {
        if (live) {
          setAnswer({ key, style: resolved === target ? { kind: 'alias' } : { kind: 'relative' } });
        }
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the project, the file and the probe; the resolver is new on every render.
  }, [key]);
  return answer?.key === key ? answer.style : RELATIVE;
}

const RELATIVE: ImportStyle = { kind: 'relative' };

/** The project's collections read from their files, with the entries the picker has asked for. */
export interface FileCollections {
  readonly collections: readonly { readonly name: string; readonly count: number }[];
  /** Entries by collection (the representative, its first) or by `name[index]` (entrySampleKey). */
  readonly samples: Record<string, unknown>;
  readonly requestSample: (collection: string, index?: number) => void;
}

// Entries asked for in one session: a picker steps through a handful.
const FILE_SAMPLES_MAX = 512;

/**
 * The content collections and their entries as the CMS reads them from the
 * project's files (content:collections, content:entries), for a host with no
 * dev server to ask (Studio). An entry reads as getCollection hands it over:
 * `{ id, collection, data }`.
 */
export function useFileCollections(projectPath: string | undefined): FileCollections {
  const [collections, setCollections] = useState<FileCollections['collections']>([]);
  const [samples, setSamples] = useState<Record<string, unknown>>({});
  const [asked] = useState(() => new Set<string>());
  useEffect(() => {
    if (projectPath === undefined) {
      return undefined;
    }
    let live = true;
    // A project whose collections cannot be read offers none: the picker still lists what is in scope.
    void readContentCollections(projectPath)
      .then((content) => {
        if (live && content.ok) {
          setCollections(content.value.collections.map((collection) => ({ name: collection.name, count: collection.count })));
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectPath]);
  const requestSample = (collection: string, index?: number): void => {
    const key = index === undefined ? collection : entrySampleKey(collection, index);
    if (projectPath === undefined || asked.has(key) || asked.size >= FILE_SAMPLES_MAX) {
      return;
    }
    asked.add(key);
    // An entry that cannot be read is forgotten, so opening the row again asks again.
    void readContentEntries(projectPath, collection)
      .then((read) => (read.ok ? read.value.entries[index ?? 0] : undefined))
      .catch(() => undefined)
      .then((entry) => {
        if (entry === undefined) {
          asked.delete(key);
          return;
        }
        setSamples((previous) => ({ ...previous, [key]: { id: entry.id, collection, data: entry.data } }));
      });
  };
  return { collections, samples, requestSample };
}
