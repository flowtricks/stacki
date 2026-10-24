import { isMobileEditor } from './mobileEditor';
import type { CmsSelection } from '../features/cms/CmsWorkspace';
import { useEditorRole } from '../features/roles/useEditorRole';
import { clientPanel } from '../features/roles/roleStore';
import { useEffect, useRef, useState } from 'react';
import { onAssetRequest, type AssetRequest } from '../../vendor/stacki/src/ui/assetPick';
import type { PreviewDevice } from '../../vendor/stacki/src/features/preview/PreviewToolbar';
import type { Panel } from './EditorRail';
import { usePreviewDimensions } from '../../vendor/stacki/src/features/preview/usePreviewSizing';
import type { VariableSelection } from '../../vendor/stacki/src/features/variables/variablesBridge';

// Editor chrome belongs to the app; source document connections switch independently.
export function useEditorView() {
  const role = useEditorRole();
  const [cms, setCms] = useState<CmsSelection>();
  const dimensions = usePreviewDimensions();
  const [device, setDevice] = useState<PreviewDevice>('desktop');
  const [panel, setPanel] = useState<Panel | undefined>(() =>
    isMobileEditor() ? undefined : 'navigator',
  );
  const [tab, setTab] = useState<'style' | 'settings'>('settings');
  const [pick, setPick] = useState<AssetRequest>();
  const [variable, setVariable] = useState<VariableSelection>();
  const previous = useRef<Panel | undefined>('navigator');
  useEffect(
    () =>
      onAssetRequest((request) => {
        setPick(request);
        setPanel((current) => {
          if (request) {
            previous.current = current;
            return 'assets';
          }
          return previous.current;
        });
      }),
    [],
  );
  return {
    role,
    device,
    setDevice,
    panel: role === 'client' && !clientPanel(panel) ? ('navigator' as const) : panel,
    setPanel,
    tab: role === 'client' ? ('settings' as const) : tab,
    setTab,
    pick,
    dimensions,
    cms,
    setCms,
    variable: role === 'client' ? undefined : variable,
    setVariable,
  };
}
