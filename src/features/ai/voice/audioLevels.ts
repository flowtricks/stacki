// The microphone's loudness, for the waveform only. The words come from the platform's speech
// recognizer; this opens a second, read-only look at the same microphone (an analyser node, no
// recording, nothing stored or sent) and turns it into bar heights.
//
// The seam is `AudioLevelSource`: tests inject a fake that publishes chosen bars, so no test
// ever opens a real microphone.
import { err, ok, type Result } from '../../../../shared/core/result';
import { barsFromSamples, smoothBars, silentBars } from '../../../../shared/properties/voice/waveform';
import { VOICE_LIMITS } from '../../../../shared/properties/voice/voiceLimits';

export type AudioLevelProblem = 'unsupported' | 'denied' | 'failed';

export interface AudioLevelSource {
  /** Starts the meter. `onBars` gets `barCount` heights about every `LEVEL_INTERVAL_MS`; the result stops it. */
  readonly start: (barCount: number, onBars: (bars: readonly number[]) => void) => Promise<Result<() => void, AudioLevelProblem>>;
}

export const LEVEL_INTERVAL_MS = 50;

/** The real meter, over the page's own microphone permission. */
export const browserAudioLevels: AudioLevelSource = {
  start: async (barCount, onBars) => {
    if (typeof navigator.mediaDevices?.getUserMedia !== 'function' || typeof AudioContext !== 'function') {
      return err('unsupported');
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error: unknown) {
      return err(error instanceof DOMException && error.name === 'NotAllowedError' ? 'denied' : 'failed');
    }
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let bars = silentBars(barCount);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      bars = smoothBars(bars, barsFromSamples(samples, barCount));
      onBars(bars);
    }, LEVEL_INTERVAL_MS);
    // The meter ends with the session bound even if a caller forgets to stop it.
    const guard = setTimeout(() => stop(), VOICE_LIMITS.sessionMsMax);
    function stop(): void {
      clearInterval(timer);
      clearTimeout(guard);
      for (const track of stream.getTracks()) {
        track.stop();
      }
      void context.close().catch(() => undefined);
    }
    return ok(stop);
  },
};
