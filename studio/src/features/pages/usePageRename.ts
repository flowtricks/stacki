import { useState } from 'react';
import { renamedPagePath, type PageRename } from '../../../vendor/stacki/shared/properties/pageRename';
import { request } from '../project/projectClient';

export function usePageRename({
  file,
  open,
  refresh,
  flushSave,
}: {
  readonly file: string;
  readonly open: (file: string) => void;
  readonly refresh: () => void;
  readonly flushSave?: (() => Promise<void>) | undefined;
}) {
  const [item, setItem] = useState<Pick<PageRename, 'kind' | 'from'>>();
  const save = async (change: PageRename) => {
    await flushSave?.();
    await request('/studio/api/pages/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(change),
    });
    window.dispatchEvent(new Event('stacki:pages-renamed'));
    refresh();
    if (file.startsWith('src/pages/')) {
      open('src/pages/' + renamedPagePath(file.slice(10), change));
    }
  };
  return {
    item,
    save,
    close: () => setItem(undefined),
    rename: (kind: PageRename['kind'], from: string) => setItem({ kind, from }),
  };
}
