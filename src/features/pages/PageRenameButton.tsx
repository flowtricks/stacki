import type React from 'react';
import { PencilIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';

export function PageRenameButton({ kind, rename }: { readonly kind: 'page' | 'folder'; readonly rename: () => void }) {
  const translate = useTranslate();
  const label = translate(kind === 'page' ? 'pages.rename.page' : 'pages.rename.folder');
  const click = (event: React.MouseEvent) => {
    event.stopPropagation();
    rename();
  };
  return (
    <button className="row-action rename-action" title={label} aria-label={label} onClick={click}>
      <PencilIcon size={12} />
    </button>
  );
}
