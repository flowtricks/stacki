import { useCallback, useEffect, useState } from 'react';
import { publishingCustomHost } from '../../ipc/publishCustomBridge';
import type { CustomPublishResult, DeployLinkDestination } from '../../../shared/properties/publishDeployLink';
import { reportErrorToast } from '../../ui/errorNotices';
import { cleanError } from '../../lib/cleanError';
import { useTranslateDescribed } from '../../lib/i18n/useTranslate';

export type CustomHostInfo = Extract<CustomPublishResult, { readonly kind: 'ready' }>;

/** What a deploy link field holds before Save. The draft is the only place the renderer ever has a link. */
export interface LinkDraft {
  readonly text: string;
  readonly replacing: boolean;
}

export const EMPTY_LINK_DRAFT: LinkDraft = { text: '', replacing: false };

/**
 * The project's scripts, Wrangler environments and saved deploy links, read only once a setting that needs them is
 * on screen, so the other hosts' settings ask nothing new of the computer (or its keychain).
 */
export function useCustomHostInfo(projectPath: string, { needed }: { readonly needed: boolean }) {
  const translateDescribed = useTranslateDescribed();
  const [info, setInfo] = useState<CustomHostInfo>();
  const [asked, setAsked] = useState(needed);
  if (needed && !asked) {
    setAsked(true);
  }
  const apply = useCallback(
    async (request: Parameters<typeof publishingCustomHost>[1]) => {
      try {
        const result = await publishingCustomHost(projectPath, request);
        if (result.kind === 'ready') {
          setInfo(result);
        } else {
          reportErrorToast(translateDescribed(result));
        }
      } catch (failure: unknown) {
        reportErrorToast(cleanError(failure));
      }
    },
    [projectPath, translateDescribed],
  );
  useEffect(() => {
    if (asked) {
      void apply({ action: 'read' });
    }
  }, [asked, apply]);
  const removeLink = useCallback((destination: DeployLinkDestination) => apply({ action: 'removeLink', destination }), [apply]);
  return { info, removeLink };
}
