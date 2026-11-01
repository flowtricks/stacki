import { canConvertAssets } from '../../ipc/editorEnvironment';
import { useEffect, useRef, useState } from 'react';
import { IMAGE_BATCH_MAX, type ImageFormat } from '../../../shared/ipc/assetConversion';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { convertAsset, deleteAsset } from './assetPanelBridge';
import type { AssetFile } from './assetPaths';
import AssetCompressionDialog from './AssetCompressionDialog';
import { AssetSelectionToolbar } from './AssetSelection';

export function useAssetBatch(projectPath: string, showToast: (message: string, kind: 'error') => void) {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [compression, setCompression] = useState<readonly AssetFile[]>();
  const execution = useBatchExecution(projectPath, { showToast, setSelected });
  const toggle = (rel: string) =>
    setSelected((previous) => {
      if (previous.has(rel)) {
        return new Set([...previous].filter((item) => item !== rel));
      }
      if (previous.size >= IMAGE_BATCH_MAX) {
        return previous;
      }
      return new Set([...previous, rel]);
    });
  return {
    selecting,
    setSelecting,
    selected,
    setSelected,
    toggle,
    compression,
    setCompression,
    ...execution,
  };
}

function useBatchExecution(
  projectPath: string,
  {
    showToast,
    setSelected,
  }: {
    readonly showToast: (message: string, kind: 'error') => void;
    readonly setSelected: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  },
) {
  const [progress, setProgress] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const running = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const run = async (files: readonly AssetFile[], operation: ImageFormat | 'delete') => {
    if (running.current || files.length === 0) {
      return;
    }
    if (files.length > IMAGE_BATCH_MAX) {
      showToast('Select at most 100 files.', 'error');
      return;
    }
    running.current = true;
    setNotice(undefined);
    try {
      if (operation === 'delete') {
        const confirmed = await confirmDialog({
          title: `Delete ${files.length} assets?`,
          body: 'Moves selected assets to the trash. Site references are kept.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!confirmed) {
          return;
        }
      }
      if (!active.current) {
        return;
      }
      for (const [index, file] of files.entries()) {
        setProgress(`${index + 1} of ${files.length} · ${file.name}`);
        const result = operation === 'delete' ? await deleteAsset(projectPath, file.rel) : await convertAsset(projectPath, file.rel, operation);
        if (!active.current) {
          return;
        }
        if (!result.ok) {
          showToast(`${file.name}: ${result.error}`, 'error');
          return;
        }
        setSelected((previous) => new Set([...previous].filter((item) => item !== file.rel)));
      }
      setNotice(`${files.length} ${operation === 'delete' ? 'assets deleted' : 'images compressed'}.`);
    } finally {
      setProgress(undefined);
      running.current = false;
    }
  };
  return { progress, notice, run };
}

export type AssetBatch = ReturnType<typeof useAssetBatch>;
export function convertible(file: AssetFile): boolean {
  return canConvertAssets && /\.(png|jpe?g|webp|avif|tiff?)$/i.test(file.name);
}
export function selectableAsset(file: AssetFile): boolean {
  return canConvertAssets ? convertible(file) : true;
}

export function AssetBatchTools({ batch, files }: { readonly batch: AssetBatch; readonly files: readonly AssetFile[] }) {
  return (
    <>
      <AssetSelectionToolbar batch={batch} files={files} />
      {batch.progress && (
        <div className="asset-batch-progress" role="status">
          <span className="mini-spinner" /> {batch.progress}
        </div>
      )}
      {batch.notice && (
        <div className="asset-batch-notice" role="status">
          {batch.notice}
        </div>
      )}
      {batch.compression && (
        <AssetCompressionDialog
          files={batch.compression}
          onClose={() => batch.setCompression(undefined)}
          onCompress={(selected, format) => {
            batch.setCompression(undefined);
            void batch.run(selected, format);
          }}
        />
      )}
    </>
  );
}
