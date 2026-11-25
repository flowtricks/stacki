// Goal: live speech is cut where a person pauses, and nothing else. A buffer of silence is not decoded
// (Whisper invents words for silence) and long silence is dropped; a phrase followed by a pause is
// committed up to the middle of the pause; a phrase still being spoken is kept; a buffer near the
// window bound is cut at its quietest frame even without a pause; noise as loud as the room is not
// speech. The bounded buffer takes only what fits and says so, and resampling keeps the length ratio.
// Methodology: synthetic 16 kHz PCM built from tones (speech), low noise (a room) and zeros (silence),
// measured through the pure functions and the SpeechBuffer, including the bounds and invalid input.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { samplesOf } from '#dist/shared/properties/voice/dictationLimits.js';
import {
  FRAME_SAMPLES,
  SpeechBuffer,
  frameEnergies,
  measureFrames,
  noiseFloorOf,
  planChunk,
  planPartial,
  quietestFrame,
  resampleLinear,
  speechFrames,
  speechMask,
  speechThreshold,
  withProbabilities,
} from '#dist/shared/properties/voice/speechChunker.js';

/** A recipe of [kind, milliseconds] parts: tone is speech at 0.2 full scale, noise a quiet room, silence zeros. */
function pcm(parts: readonly (readonly ['tone' | 'noise' | 'silence' | 'loudNoise' | 'blast' | 'click', number])[]): Float32Array {
  const total = parts.reduce((sum, [, ms]) => sum + samplesOf(ms), 0);
  const samples = new Float32Array(total);
  let at = 0;
  let seed = 7;
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648 - 0.5;
  };
  for (const [kind, ms] of parts) {
    const count = samplesOf(ms);
    for (let index = 0; index < count; index += 1) {
      const seconds = (at + index) / 16_000;
      samples[at + index] =
        kind === 'tone'
          ? 0.2 * Math.sin(2 * Math.PI * 220 * seconds)
          : kind === 'noise'
            ? 0.004 * random()
            : kind === 'loudNoise'
              ? 0.08 * random()
              : kind === 'blast'
                ? 0.6 * random()
                : kind === 'click'
                  ? 0.5
                  : 0;
    }
    at += count;
  }
  return samples;
}

const plan = (samples: Float32Array, phase: 'live' | 'final' = 'live') => {
  const frames = measureFrames(samples);
  return planChunk(frames, samples.length, phase, noiseFloorOf(frames));
};
const heardMs = (samples: Float32Array): number => {
  const frames = measureFrames(samples);
  return speechFrames(speechMask(frames, speechThreshold(noiseFloorOf(frames), frames.energies))) * 30;
};

test('frames are 30 ms and measure loudness; a partial frame waits for the next call', () => {
  assert.equal(FRAME_SAMPLES, 480);
  const energies = frameEnergies(pcm([['tone', 300]]));
  assert.equal(energies.length, 10);
  assert.ok(Math.abs((energies[3] ?? 0) - 0.2 / Math.SQRT2) < 0.01, 'a sine of amplitude 0.2 has an RMS near 0.141');
  assert.equal(frameEnergies(new Float32Array(479)).length, 0);
});

test('silence, a quiet room, loud noise and a click are not speech; a voice is', () => {
  assert.equal(heardMs(pcm([['silence', 2_000]])), 0);
  assert.equal(heardMs(pcm([['noise', 2_000]])), 0);
  assert.equal(heardMs(pcm([['loudNoise', 2_000]])), 0, 'noise crosses zero like noise, not like a voice');
  assert.equal(
    heardMs(
      pcm([
        ['noise', 300],
        ['blast', 1_000],
      ]),
    ),
    0,
    'even very loud noise over a quiet floor',
  );
  assert.equal(
    heardMs(
      pcm([
        ['noise', 300],
        ['click', 60],
        ['noise', 600],
      ]),
    ),
    0,
    'a click is shorter than the onset',
  );
  assert.ok(
    heardMs(
      pcm([
        ['noise', 300],
        ['tone', 500],
        ['noise', 300],
      ]),
    ) >= 450,
    'a voice is heard',
  );
});

test('the noise floor comes from the first 300 ms and the threshold stays within bounds', () => {
  assert.equal(noiseFloorOf(measureFrames(pcm([['noise', 200]]))), undefined, 'not enough heard yet');
  const floor = noiseFloorOf(
    measureFrames(
      pcm([
        ['loudNoise', 300],
        ['tone', 1_000],
      ]),
    ),
  );
  assert.ok(floor !== undefined && floor > 0.015 && floor < 0.035, `the room (${floor}) is the loud noise, not the tone`);
  const allSpeech = measureFrames(pcm([['tone', 2_000]]));
  assert.ok(speechThreshold(noiseFloorOf(allSpeech), allSpeech.energies) <= 0.06, 'a session that starts mid-word still hears speech');
  assert.ok(speechThreshold(0, new Float32Array(0)) >= 0.012);
  assert.throws(() => speechMask(allSpeech, 0), /positive threshold/);
});

test('hysteresis: a word with a short dip stays one run; a long gap ends it', () => {
  const dipped = measureFrames(
    pcm([
      ['noise', 300],
      ['tone', 300],
      ['silence', 90],
      ['tone', 300],
    ]),
  );
  const mask = speechMask(dipped, speechThreshold(noiseFloorOf(dipped), dipped.energies));
  const first = mask.indexOf(1);
  const last = mask.lastIndexOf(1);
  assert.equal(speechFrames(mask, first, last + 1), last - first + 1, 'a 90 ms dip is inside the word');
  const gapped = measureFrames(
    pcm([
      ['noise', 300],
      ['tone', 300],
      ['silence', 400],
      ['tone', 300],
    ]),
  );
  const gapMask = speechMask(gapped, speechThreshold(noiseFloorOf(gapped), gapped.energies));
  assert.ok(speechFrames(gapMask) < gapMask.lastIndexOf(1) - gapMask.indexOf(1) + 1, 'a 400 ms gap is not speech');
});

test('under 300 ms of speech is never decoded: dropped at a pause and at the end', () => {
  const short = pcm([
    ['noise', 300],
    ['tone', 200],
    ['silence', 800],
  ]);
  assert.equal(plan(short).kind, 'drop');
  assert.equal(
    plan(
      pcm([
        ['noise', 300],
        ['tone', 200],
      ]),
      'final',
    ).kind,
    'drop',
  );
  assert.equal(planPartial(measureFrames(short), short.length, undefined), undefined);
});

test('a committed window is trimmed to its speech plus 150 ms on each side', () => {
  const samples = pcm([
    ['silence', 1_000],
    ['tone', 1_000],
    ['silence', 900],
  ]);
  const result = plan(samples);
  assert.equal(result.kind, 'commit');
  if (result.kind === 'commit') {
    assert.ok(Math.abs(result.window.from - samplesOf(850)) <= FRAME_SAMPLES * 2, `starts 150 ms before the speech (${result.window.from})`);
    assert.ok(Math.abs(result.window.to - samplesOf(2_150)) <= FRAME_SAMPLES * 2, `ends 150 ms after it (${result.window.to})`);
    assert.ok(result.samples > result.window.to, 'the pause is dropped with it');
    assert.ok(result.window.evidence.speechMs >= 900);
    assert.ok(result.window.evidence.speechRatio > 0.7);
  }
});

test('a buffer of silence is kept while short, dropped when long, and dropped whole at the end', () => {
  assert.deepEqual(plan(pcm([['silence', 1_000]])), { kind: 'keep' });
  const long = plan(pcm([['silence', 3_000]]));
  assert.equal(long.kind, 'drop');
  assert.ok(long.kind === 'drop' && long.samples === samplesOf(3_000) - samplesOf(150), 'the last 150 ms stay for a first syllable');
  assert.deepEqual(plan(pcm([['silence', 1_000]]), 'final'), { kind: 'drop', samples: samplesOf(1_000) });
  assert.deepEqual(plan(new Float32Array(0), 'final'), { kind: 'keep' });
});

test('a phrase followed by a pause is committed up to the middle of the pause', () => {
  const samples = pcm([
    ['tone', 1_500],
    ['silence', 900],
    ['tone', 400],
  ]);
  const result = plan(samples);
  assert.equal(result.kind, 'commit');
  // Where the cut falls, in samples of the audio (a position, not a duration).
  const cutAt = result.kind === 'commit' ? result.samples : 0;
  assert.ok(cutAt > samplesOf(1_500) && cutAt < samplesOf(2_400), `the cut (sample ${cutAt}) is inside the pause`);
});

test('a pause still running at the end counts: the words land when the person stops talking', () => {
  const result = plan(
    pcm([
      ['tone', 1_200],
      ['silence', 700],
    ]),
  );
  assert.equal(result.kind, 'commit');
});

test('a phrase still being spoken, or a pause too short, is kept', () => {
  assert.deepEqual(plan(pcm([['tone', 2_000]])), { kind: 'keep' });
  assert.deepEqual(
    plan(
      pcm([
        ['tone', 1_000],
        ['silence', 300],
        ['tone', 1_000],
      ]),
    ),
    { kind: 'keep' },
  );
});

test('a long quiet start before the first word is dropped so the window holds speech', () => {
  const result = plan(
    pcm([
      ['silence', 3_000],
      ['tone', 1_000],
    ]),
  );
  assert.equal(result.kind, 'drop');
});

test('at the end everything with speech is one last segment', () => {
  const samples = pcm([['tone', 1_000]]);
  const result = plan(samples, 'final');
  assert.equal(result.kind, 'commit');
  assert.ok(result.kind === 'commit' && result.samples === samples.length);
});

test('near the window bound with no pause, the cut is the quietest frame in the second half', () => {
  const samples = pcm([
    ['tone', 20_000],
    ['noise', 90],
    ['tone', 8_500],
  ]);
  const result = plan(samples);
  assert.equal(result.kind, 'commit');
  assert.ok(result.kind === 'commit' && result.samples > samples.length / 2, 'the forced cut is in the second half');
  assert.ok(result.kind === 'commit' && result.samples < samples.length, 'and leaves the rest for the next window');
});

test('quietestFrame never cuts at zero and refuses frames outside the buffer', () => {
  assert.equal(quietestFrame(Float32Array.from([0, 1, 1]), 0), 1);
  assert.equal(quietestFrame(Float32Array.from([1, 0.5, 0.1, 0.3]), 1), 2);
  assert.throws(() => quietestFrame(Float32Array.from([1]), 1), /within the frames/);
});

test('the buffer takes only what fits, copies and drops exactly, and refuses impossible counts', () => {
  const buffer = new SpeechBuffer();
  assert.equal(buffer.capacity, samplesOf(30_000));
  assert.equal(buffer.append(Float32Array.from([0.1, 0.2, 0.3])), 3);
  assert.deepEqual(Array.from(buffer.copy(2)), [Math.fround(0.1), Math.fround(0.2)]);
  assert.deepEqual(Array.from(buffer.copy(3, 2)), [Math.fround(0.3)]);
  buffer.drop(1);
  assert.deepEqual(Array.from(buffer.copy(2)), [Math.fround(0.2), Math.fround(0.3)]);
  assert.throws(() => buffer.copy(3), /only what was appended/);
  assert.throws(() => buffer.drop(-1), /never negative/);
  const full = new SpeechBuffer();
  assert.equal(full.append(new Float32Array(full.capacity + 100)), full.capacity, 'the overflow is reported, not stored');
  assert.equal(full.append(new Float32Array(10)), 0);
  full.clear();
  assert.equal(full.length, 0);
});

test('resampling 48 kHz to 16 kHz keeps a third of the samples and the shape', () => {
  const source = Float32Array.from({ length: 4_800 }, (_value, index) => Math.sin(index / 50));
  const target = resampleLinear(source, 48_000, 16_000);
  assert.equal(target.length, 1_600);
  assert.ok(Math.abs((target[100] ?? 0) - Math.sin(300 / 50)) < 1e-3);
  assert.throws(() => resampleLinear(source, 0, 16_000), /positive source rate/);
});

test('with Silero, speech needs the network and the room: a loud non-voice and a quiet far voice both stay quiet', () => {
  const samples = pcm([
    ['noise', 300],
    ['tone', 1_000],
    ['noise', 700],
  ]);
  const frames = measureFrames(samples);
  // One probability per 512-sample window: speech only where the network says so.
  const windows = Math.ceil(samples.length / 512);
  const sure = {
    values: Array.from({ length: windows }, (_value, index) => (index * 512 >= samplesOf(300) && index * 512 < samplesOf(1_300) ? 0.95 : 0.02)),
    windowBase: 0,
  };
  const scored = withProbabilities(frames, sure, 0);
  assert.equal(scored.probabilities?.length, frames.energies.length);
  const mask = speechMask(scored, speechThreshold(noiseFloorOf(scored), scored.energies));
  assert.ok(speechFrames(mask) * 30 >= 900, 'the voice the network hears is speech');
  const doubtful = { values: Array.from({ length: windows }, () => 0.2), windowBase: 0 };
  const rejected = withProbabilities(frames, doubtful, 0);
  assert.equal(
    speechFrames(speechMask(rejected, speechThreshold(noiseFloorOf(rejected), rejected.energies))),
    0,
    'a tone the network does not call speech is not',
  );
  const quietVoice = measureFrames(
    pcm([
      ['noise', 300],
      ['noise', 1_000],
    ]),
  );
  const loudSure = withProbabilities(quietVoice, { values: Array.from({ length: windows }, () => 0.99), windowBase: 0 }, 0);
  assert.equal(
    speechFrames(speechMask(loudSure, speechThreshold(noiseFloorOf(loudSure), loudSure.energies))),
    0,
    'a voice no louder than the room is not dictation',
  );
  assert.throws(() => withProbabilities(frames, sure, -1), /real sample/);
});

test('a window whose speech starts at the buffer start has no onset; one after quiet has', () => {
  const after = plan(
    pcm([
      ['silence', 500],
      ['tone', 1_000],
      ['silence', 800],
    ]),
  );
  assert.ok(after.kind === 'commit' && after.window.evidence.onset);
  const start = plan(
    pcm([
      ['tone', 1_000],
      ['silence', 800],
    ]),
  );
  assert.ok(start.kind === 'commit' && !start.window.evidence.onset);
  assert.ok(start.kind === 'commit' && start.forced === false);
});
