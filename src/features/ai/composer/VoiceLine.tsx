// The line under the box while the microphone is open: the live waveform, then what is being
// said (cleaned, as it will land) or, when nothing is being said, what to do next. The line
// is there on the first frame of the press, with the bars as a skeleton, so voice input feels
// instant even while the system is still answering for the microphone.
import { useTranslate } from '../../../lib/i18n/useTranslate';
import type { VoiceLatch } from '../../../../shared/properties/voice/voiceSession';
import type { LevelFeed } from '../voice/levelFeed';
import { Waveform } from '../voice/Waveform';

export function VoiceLine({
  feed,
  starting,
  latch,
  interim,
  commands,
}: {
  readonly feed: LevelFeed;
  readonly starting: boolean;
  readonly latch: VoiceLatch;
  readonly interim: string;
  /** Whether spoken commands are active (they are English words). */
  readonly commands: boolean;
}) {
  const translate = useTranslate();
  // A press still down is a hold until it comes up quickly: the hint for it is the one that ends it.
  const handsFree = commands ? translate('ai.voice.hintHandsFree') : translate('ai.voice.hintHandsFreeBasic');
  const hint = latch === 'handsfree' ? handsFree : translate('ai.voice.hintHold');
  return (
    <div className="ai-voice-line">
      <Waveform feed={feed} starting={starting} />
      <span className={`ai-voice-text${interim === '' ? ' is-hint' : ''}`}>{interim === '' ? hint : interim}</span>
    </div>
  );
}
