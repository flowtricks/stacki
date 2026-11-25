// Turns whatever a media-host form caught into the sentence to show. A `MediaInputError` (shared/properties/mediaInputError.ts) carries a
// message reference; its `what` parameter names the field in English ("S3 endpoint"), so it is translated here, where the language is
// known. Any other error shows its own message, as received.
import { useCallback } from 'react';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { MediaInputError } from '../../../shared/properties/mediaInputError';

const FIELD_NAME_KEYS: Readonly<Record<string, MessageKey>> = {
  'S3 endpoint': 'assets.input.what.endpoint',
  'public bucket URL': 'assets.input.what.publicBucketUrl',
  'pull zone URL': 'assets.input.what.pullZoneUrl',
  'public URL': 'assets.input.what.publicUrl',
  'file URL': 'assets.input.what.fileUrl',
  'access key ID': 'assets.input.what.accessKeyId',
  'secret access key': 'assets.input.what.secretAccessKey',
  'storage password': 'assets.input.what.storagePassword',
  'Cloudflare API token': 'assets.input.what.cloudflareToken',
  'Bunny API key': 'assets.input.what.bunnyKey',
  bucket: 'assets.input.what.bucket',
  'storage zone': 'assets.input.what.storageZone',
  account: 'assets.input.what.account',
};

export function useMediaErrorText(): (reason: unknown) => string {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  return useCallback(
    (reason: unknown): string => {
      if (reason instanceof MediaInputError) {
        const params = reason.messageRef.params;
        const what = params?.['what'];
        const nameKey = typeof what === 'string' ? FIELD_NAME_KEYS[what] : undefined;
        const translatedParams = params === undefined || nameKey === undefined ? params : { ...params, what: translate(nameKey) };
        return translateDescribed({
          message: reason.message,
          messageRef: translatedParams === undefined ? { key: reason.messageRef.key } : { key: reason.messageRef.key, params: translatedParams },
        });
      }
      return reason instanceof Error ? reason.message : String(reason);
    },
    [translate, translateDescribed],
  );
}
