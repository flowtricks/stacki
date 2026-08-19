// Interface sound: a short, soft note as a value moves under the pointer.
//
// Off unless the setting says otherwise — an editor that makes noise the first
// time you touch it is an editor people turn off, so this one starts silent and
// is switched on from File ▸ Interface Sounds. Nothing here is constructed until
// the first note is asked for, so a session with the setting off never creates
// an AudioContext at all.
//
// "Muted" is meant as an instrument does: a saw through a low-pass, quiet, with
// a soft attack and a quick decay. No click at either end, and nothing that
// carries across a room.
//
// The drag has two axes and so does the note. Across is pitch. Up and down is
// how hard it is played: at the bottom the filter is nearly shut and the note
// is round and slow, at the top it is open and the note is bright and struck.
// One waveform throughout — a sawtooth has the harmonics to be either, and the
// filter decides how many of them are heard, which is what a mute is.

// The scale. A minor pentatonic over two octaves: any two notes in it sit well
// together, so a fast drag reads as a run rather than a siren — which a linear
// sweep through frequencies is. Dragging right climbs it, dragging left comes
// back down.
const SEMITONES = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];
const ROOT_HZ = 196; // G3 — low enough to stay out of the way of speech
const LAST = SEMITONES.length - 1;

// A pointer emits moves far faster than notes are worth playing, so a note is
// one STEP of the scale rather than one move: sliding through a step sounds it,
// holding still says nothing. The floor is a backstop for a wild drag that
// crosses several steps in a frame.
const FLOOR_MS = 25;

// How the vertical is heard. Fewer levels than the scale has steps: this is a
// character, not a melody, and a note per pixel of vertical travel would be the
// machine gun the steps above exist to avoid.
const BITE_LEVELS = 5;

// The two ends of the vertical, and everything between them is a mix. A shut
// filter over a slow attack is a note played with the side of the hand; an open
// one over a fast attack is the same note struck.
const MUTED = { cutoff: 420, gain: 0.55, attack: 0.014, decay: 0.2 };
const SHARP = { cutoff: 2200, gain: 1, attack: 0.002, decay: 0.09 };
const mix = (a, b, t) => a + (b - a) * t;

let enabled = false;
let ctx = null;
// Where a note is played into: the master gain. Each note brings its own
// filter, since the filter is what the vertical axis moves.
let input = null;
// Both axes: moving up and down without moving across is still a change worth
// hearing, so the note that was last played is remembered as the pair.
let lastKey = '';
// "Never" rather than "at time zero": performance.now() starts near zero, so a
// zero here silently swallowed the first note of a drag made in the app's first
// few milliseconds.
let lastAt = Number.NEGATIVE_INFINITY;

/** Whether notes are being played at all. */
export function soundEnabled() {
  return enabled;
}

/** The setting, from the menu (and once at startup). */
export function setSoundEnabled(on) {
  enabled = !!on;
  // So the next drag starts from wherever it starts, rather than being judged
  // against a note from before the setting changed.
  lastKey = '';
}

// Built on the first note, which is inside a pointer event — the gesture a
// browser requires before it will let anything make sound.
function bench() {
  if (ctx) return ctx;
  const Ctor = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!Ctor) return null;
  ctx = new Ctor();
  const master = ctx.createGain();
  master.gain.value = 0.06; // quiet enough to sit under a conversation
  master.connect(ctx.destination);
  input = master;
  return ctx;
}

function note(hz, tone) {
  const audio = bench();
  if (!audio) return;
  // A tab that has been away can come back suspended.
  if (audio.state === 'suspended') void audio.resume();
  const at = audio.currentTime;
  const osc = audio.createOscillator();
  const mute = audio.createBiquadFilter();
  const env = audio.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(hz, at);
  mute.type = 'lowpass';
  // Never below the note itself: a cutoff under the fundamental doesn't mute
  // the note, it removes it. Only just above it, though — at this range the
  // floor is a backstop for the top of the scale, not the thing setting the
  // tone, and a wide margin here would undo the muting it exists to protect.
  mute.frequency.setValueAtTime(Math.max(tone.cutoff, hz * 1.25), at);
  mute.Q.setValueAtTime(0.7, at);
  // The ramp matters more than the shape: a gain that starts or ends on a step
  // is a click, which is the sound of a bug.
  env.gain.setValueAtTime(0.0001, at);
  env.gain.linearRampToValueAtTime(tone.gain, at + tone.attack);
  env.gain.exponentialRampToValueAtTime(0.0001, at + tone.attack + tone.decay);
  osc.connect(mute);
  mute.connect(env);
  env.connect(input);
  osc.start(at);
  osc.stop(at + tone.attack + tone.decay + 0.02);
  osc.onended = () => {
    osc.disconnect();
    mute.disconnect();
    env.disconnect();
  };
}

/**
 * The note for a position in a control, as 0..1 fractions of its size.
 *
 * `fx` is across: right is higher, left is lower. `fy` is down the way a
 * pointer reports it — 0 at the top, 1 at the bottom — so down is muted and up
 * is played hard. Leave `fy` out for a control where it means nothing: a hue
 * bar is a few pixels tall, and a fraction of that is noise rather than intent.
 *
 * Safe to call on every pointer move: it decides for itself whether the move is
 * worth a sound.
 */
export function dragNote(fraction, verticalFraction) {
  if (!enabled) return;
  const f = Number(fraction);
  if (!Number.isFinite(f)) return;
  const step = Math.max(0, Math.min(LAST, Math.round(f * LAST)));
  const level = biteLevel(verticalFraction);
  const key = `${step}:${level}`;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (key === lastKey || now - lastAt < FLOOR_MS) return;
  lastKey = key;
  lastAt = now;
  note(ROOT_HZ * Math.pow(2, SEMITONES[step] / 12), toneFor(level));
}

/** The pitch a fraction sounds at — exported for the tests, and for tuning. */
export function noteHzFor(fraction) {
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  return ROOT_HZ * Math.pow(2, SEMITONES[Math.round(f * LAST)] / 12);
}

// Which of the levels a vertical fraction falls in. Nothing given — a control
// with no meaningful height — sits in the middle, which is where every note
// sounded before there was an up and a down.
function biteLevel(verticalFraction) {
  const y = Number(verticalFraction);
  if (!Number.isFinite(y)) return (BITE_LEVELS - 1) / 2;
  const up = 1 - Math.max(0, Math.min(1, y));
  return Math.round(up * (BITE_LEVELS - 1));
}

function toneFor(level) {
  const t = level / (BITE_LEVELS - 1);
  return {
    cutoff: mix(MUTED.cutoff, SHARP.cutoff, t),
    gain: mix(MUTED.gain, SHARP.gain, t),
    attack: mix(MUTED.attack, SHARP.attack, t),
    decay: mix(MUTED.decay, SHARP.decay, t),
  };
}

/**
 * How a note at this height is played — exported for the tests and for tuning.
 * `fy` is 0 at the top (struck) and 1 at the bottom (muted).
 */
export function noteToneFor(verticalFraction) {
  return toneFor(biteLevel(verticalFraction));
}

// Moving down a list is moving down in pitch — the opposite way round to a
// drag, where right is higher, because a list runs downward and a track runs
// across. Lighter than a drag note too: a sweep down a long menu is a lot of
// notes, and each one only has to mark that the highlight moved.
const HOVER = { cutoff: 1200, gain: 0.5, attack: 0.003, decay: 0.075 };

/**
 * The highlight moved to row `index` of `count`. The first row is the highest
 * note, the last the lowest. One note per row: called again for the same row —
 * the pointer moving within it — is silent.
 */
export function hoverNote(index, count) {
  if (!enabled) return;
  const rows = Math.max(1, Math.floor(Number(count)) || 1);
  const row = Math.max(0, Math.min(rows - 1, Math.floor(Number(index)) || 0));
  const key = `row:${row}/${rows}`;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (key === lastKey || now - lastAt < FLOOR_MS) return;
  lastKey = key;
  lastAt = now;
  // Down the list is down the scale: the top row is the top of it.
  const from = rows > 1 ? row / (rows - 1) : 0;
  const step = Math.round((1 - from) * LAST);
  note(ROOT_HZ * Math.pow(2, SEMITONES[step] / 12), HOVER);
}

/** The pitch a row sounds at — exported for the tests, and for tuning. */
export function rowHzFor(index, count) {
  const rows = Math.max(1, Math.floor(Number(count)) || 1);
  const row = Math.max(0, Math.min(rows - 1, Math.floor(Number(index)) || 0));
  const from = rows > 1 ? row / (rows - 1) : 0;
  return ROOT_HZ * Math.pow(2, SEMITONES[Math.round((1 - from) * LAST)] / 12);
}

// A button is not a value: nothing about it is higher or lower, so it does not
// take a pitch from anywhere. One short, dry tap at the bottom of the range —
// dark enough that a panel full of buttons doesn't chatter.
const TAP = { hz: 174, cutoff: 900, gain: 0.5, attack: 0.001, decay: 0.055 };

/** A button was pressed. */
export function clickNote() {
  if (!enabled) return;
  note(TAP.hz, TAP);
}

/** Forget the last drag, so the next one sounds its first note. */
export function endDragNotes() {
  lastKey = '';
}
