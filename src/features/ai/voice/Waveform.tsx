// The live waveform under the box while the microphone is open. Bars are filled shapes (no
// borders); heights come from the meter's feed through a transform, so a frame is a style
// change and never a layout. Before the microphone is open the same bars pulse as a skeleton
// (docs/ui-loading.md): the row is there on the first frame and nothing says "loading".
import { useEffect, useState } from 'react';
import { silentBars } from '../../../../shared/properties/voice/waveform';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import type { LevelFeed } from './levelFeed';

export const WAVEFORM_BARS = 28;

export function Waveform({ feed, starting }: { readonly feed: LevelFeed; readonly starting: boolean }) {
  const translate = useTranslate();
  const [bars, setBars] = useState<readonly number[]>(() => silentBars(WAVEFORM_BARS));
  useEffect(() => feed.subscribe(setBars), [feed]);
  return (
    <span className={`ai-wave${starting ? ' is-starting' : ''}`} role="img" aria-label={translate('ai.voice.level')}>
      {bars.map((level, index) => (
        // The bars are a fixed row that never reorders, so the index is their identity.
        <span key={index} className="ai-wave-bar" style={{ transform: `scaleY(${Math.max(0.12, level)})` }} />
      ))}
    </span>
  );
}
