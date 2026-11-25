// The language's messages and number format, together, for the transcript's pure wording functions (chatStatus.ts,
// transcript/transcriptModel.ts), which take them as one `ChatWords` value so a component passes a single argument.
import { useMemo } from 'react';
import { useFormat, useTranslate } from '../../lib/i18n/useTranslate';
import type { ChatWords } from './chatStatus';

export function useChatWords(): ChatWords {
  const translate = useTranslate();
  const { formatNumber } = useFormat();
  return useMemo(() => ({ translate, formatNumber }), [translate, formatNumber]);
}
