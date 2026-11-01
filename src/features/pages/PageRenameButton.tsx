import type React from 'react';
import { PencilIcon } from '../../ui/Icons';

export function PageRenameButton({ kind, rename }: { readonly kind: 'page' | 'folder'; readonly rename: () => void }) {
  const click = (event: React.MouseEvent) => {
    event.stopPropagation();
    rename();
  };
  return (
    <button className="row-action rename-action" title={`Rename ${kind}`} aria-label={`Rename ${kind}`} onClick={click}>
      <PencilIcon size={12} />
    </button>
  );
}
