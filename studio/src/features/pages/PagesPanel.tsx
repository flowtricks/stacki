import { RenamePageDialog } from './RenamePageDialog';
import { usePageRename } from './usePageRename';
import { useProjectPageOrder } from '../../../vendor/stacki/src/features/pages/pageOrderPersistence';
import { usePageOrderDrag } from '../../../vendor/stacki/src/features/pages/usePageOrderDrag';
import { PageOrderNotice } from '../../../vendor/stacki/src/features/pages/PageOrderNotice';
import { useState } from 'react';
import type { Peer } from '../collaboration/presence';
import { PageFileList } from './PageFileList';
import { CreateFileDialog } from './CreateFileDialog';
import { PlusIcon } from '../../../vendor/stacki/src/ui/Icons';
import { request, type Project } from '../project/projectClient';
import { record, string } from '../../shared/validation';

interface Props {
  readonly flushSave?: (() => Promise<void>) | undefined;
  readonly project: Project;
  readonly peers: readonly Peer[];
  readonly file: string;
  readonly open: (file: string) => void;
  readonly refresh: () => void;
  readonly error: (error: unknown) => void;
  readonly collection?: boolean;
}
export function PagesPanel({ project, flushSave, peers, file, open, refresh, error, collection = false }: Props) {
  const renaming = usePageRename({ file, open, refresh, flushSave });
  const ordering = useProjectPageOrder(collection ? undefined : project.name);
  const reorder = usePageOrderDrag({
    order: ordering.state.order,
    enabled: !collection && ordering.state.kind === 'ready',
    save: ordering.save,
  });
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const { busy, create, failure } = useCreateFile({ file, collection, refresh, open, error }, () => setCreating(false));
  const items = collection ? project.collections : project.pages;
  return (
    <div className="panel-section grow">
      <PagesHeader collection={collection} create={() => setCreating(!creating)} />
      <div className="panel-search">
        <input
          aria-label="Search files"
          maxLength={512}
          placeholder={collection ? 'Search collections…' : 'Search pages…'}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {creating && <CreateFileDialog create={create} collection={collection} busy={busy} failure={failure} close={() => setCreating(false)} />}
      <ProjectRenameDialog renaming={renaming} project={project} />
      <PageOrderNotice state={ordering.state} reload={ordering.reload} />
      <PageFileList
        rename={renaming.rename}
        order={ordering.state.order}
        reorder={reorder}
        items={items}
        folders={project.pageFolders}
        pageMetadata={project.pageMetadata}
        query={query}
        file={file}
        peers={peers}
        open={open}
        collection={collection}
      />
      {!items.length && <div className="panel-note">{collection ? 'JSON and Markdown files in src/content and src/data appear here.' : 'No pages found.'}</div>}
    </div>
  );
}

async function newFileSource({ name, file, duplicate, collection }: { name: string; file: string; duplicate: boolean; collection: boolean }) {
  let source = '---\n---\n\n<main>\n\t<h1>New page</h1>\n</main>\n';
  if (duplicate) {
    source = string(record(await request(`/studio/api/file?file=${encodeURIComponent(file)}`))['source']);
  } else if (collection) {
    source = name.endsWith('.json') ? '{\n\t"title": "New item"\n}\n' : '---\ntitle: New item\n---\n\nWrite your content here.\n';
  }
  return source;
}

async function createProjectFile(
  { name, file, duplicate, collection }: { name: string; file: string; duplicate: boolean; collection: boolean },
  destination: string,
) {
  const source = await newFileSource({ name, file, duplicate, collection });
  await request('/studio/api/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: destination, source }),
  });
}

function useCreateFile(
  { file, collection = false, refresh, open, error }: Pick<Props, 'file' | 'collection' | 'refresh' | 'open' | 'error'>,
  close: () => void,
) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  async function create(name: string, duplicate = false) {
    if (busy) {
      return;
    }
    setBusy(true);
    setFailure('');
    try {
      const destination = collection ? `src/content/${name}` : `src/pages/${name.replace(/\.astro$/, '')}.astro`;
      await createProjectFile({ name, file, duplicate, collection }, destination);
      refresh();
      open(destination);
      close();
    } catch (problem) {
      setFailure(problem instanceof Error ? problem.message : String(problem));
      error(problem);
    } finally {
      setBusy(false);
    }
  }
  return { busy, create, failure };
}
function PagesHeader({ collection, create }: { readonly collection: boolean; readonly create: () => void }) {
  return (
    <div className="panel-header">
      <h2>{collection ? 'Collections' : 'Pages'}</h2>
      <div className="studio-panel-actions">
        <button className="ghost" aria-label={collection ? 'Create item' : 'Create page'} onClick={create}>
          <PlusIcon size={16} />
        </button>
      </div>
    </div>
  );
}

function ProjectRenameDialog({ renaming, project }: { readonly renaming: ReturnType<typeof usePageRename>; readonly project: Project }) {
  if (!renaming.item) {
    return undefined;
  }
  return (
    <RenamePageDialog
      key={renaming.item.kind + ':' + renaming.item.from}
      item={renaming.item}
      inventory={{
        pages: project.pages.map((page) => page.slice(10)),
        folders: project.pageFolders ?? [],
      }}
      save={renaming.save}
      close={renaming.close}
    />
  );
}
