// The microphone of a message box (useComposerVoice.ts): hold to talk, or tap to latch hands-free; while the
// dictation model downloads for a press, its progress ring stands where the microphone was. The chat's composer
// draws it as the bottom segment of the capture bar, a comment pin's popover on its own. The tip is the app's own
// (FittedTooltip keeps it inside the window), never a native `title`.
import { createPortal } from 'react-dom';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { microphone as centralMicrophone } from '../../../ui/central/centralGeometry';
import FittedTooltip from '../../../ui/FittedTooltip';
import { tooltipHost, useDelayedTooltip } from '../../../ui/delayedTooltip';
import { ProgressRing } from '../../../ui/ProgressRing';
import { useTranslate, useTranslateRef } from '../../../lib/i18n/useTranslate';
import type { ComposerVoice } from './useComposerVoice';

const MicGlyph = centralIcon(centralMicrophone);

export function MicButton({ dictation, disabled }: { readonly dictation: ComposerVoice; readonly disabled?: boolean | undefined }) {
  const translate = useTranslate();
  const translateRef = useTranslateRef();
  const micTip = useDelayedTooltip();
  const { voice, resetHistory } = dictation;
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        className={`ghost ai-tool-button${voice.listening ? ' is-listening' : ''}${voice.downloadPercent === undefined ? '' : ' is-downloading'}${voice.decoding && voice.interim === '' ? ' is-decoding' : ''}`}
        aria-label={
          voice.downloadPercent !== undefined
            ? translate('dictation.mic.downloading', { percent: voice.downloadPercent })
            : voice.listening
              ? translate('ai.composer.dictate.stop')
              : translate('ai.composer.dictate')
        }
        aria-pressed={voice.listening}
        onMouseEnter={micTip.show}
        onMouseLeave={micTip.hide}
        onBlur={micTip.hide}
        onPointerDown={(event) => {
          // Keep the button's own pointer until it comes up, even if the pointer leaves it: that is how a hold ends.
          if (typeof event.currentTarget.setPointerCapture === 'function' && event.pointerId !== undefined) {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          resetHistory();
          voice.press();
        }}
        onPointerUp={voice.release}
        onPointerCancel={voice.release}
        onClick={(event) => {
          // A pointer's press and release already happened; a click with no pointer (Space or Enter on the focused button) toggles.
          if (event.detail === 0) {
            resetHistory();
            voice.toggle();
          }
        }}
      >
        {voice.downloadPercent === undefined ? (
          <MicGlyph />
        ) : (
          // The model downloading for this press: real bytes as a ring where the microphone was; a press cancels.
          <ProgressRing
            value={voice.downloadPercent / 100}
            tone="neutral"
            sizePx={16}
            label={translate('dictation.mic.downloading', { percent: voice.downloadPercent })}
          />
        )}
      </button>
      {micTip.value !== undefined &&
        createPortal(
          <FittedTooltip role="tooltip" anchor={micTip.value} preferred="left">
            {voice.downloadPercent !== undefined
              ? translate('dictation.mic.downloading', { percent: voice.downloadPercent })
              : voice.supported
                ? translate('ai.composer.dictate.title')
                : translateRef(voice.unavailableTitle)}
          </FittedTooltip>,
          tooltipHost(undefined),
        )}
    </>
  );
}
