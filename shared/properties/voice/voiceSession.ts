// The life of one listening session as a state machine, so the microphone button, the
// recognizer and the timers cannot disagree about what is happening (AGENTS.md §1: state is a
// union, data lives only in the states that have it).
//
//   idle ──press──▶ starting ──started──▶ listening ──stop──▶ stopping ──ended──▶ idle
//
// One button, two ways to use it, as dictation tools commonly offer:
//   - hold: press and keep pressing; letting go ends the session (push to talk);
//   - latch: a short press keeps listening hands-free; the next press ends it.
// `reduceVoice` is pure: it takes the state and an event and returns the next state and the
// one thing the caller must now do (`effect`). Nothing here touches a clock, a microphone or React.
import { assert } from '../../core/assert';
import { VOICE_LIMITS } from './voiceLimits';

/** `pending` while the button is still down and it is not yet known whether this is a hold or a tap. */
export type VoiceLatch = 'pending' | 'hold' | 'handsfree';

export type VoiceState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting'; readonly latch: VoiceLatch; readonly pressedAtMs: number }
  | { readonly kind: 'listening'; readonly latch: VoiceLatch; readonly pressedAtMs: number; readonly restarts: number }
  | { readonly kind: 'stopping' };

export type VoiceEvent =
  | { readonly kind: 'press'; readonly atMs: number }
  | { readonly kind: 'release'; readonly atMs: number }
  /** A keyboard or voice stop: end the session whatever the latch. */
  | { readonly kind: 'stop' }
  /** Permission was given and the recognizer is running. */
  | { readonly kind: 'started' }
  /** The recognizer could not start (permission, no engine): back to idle. */
  | { readonly kind: 'failed' }
  /** The recognizer ended by itself (a pause) or after a stop. */
  | { readonly kind: 'ended' }
  /** `silentMs` of silence since the last speech. */
  | { readonly kind: 'silence'; readonly silentMs: number };

/** What the caller must do after a transition; at most one thing. */
export type VoiceEffect = 'none' | 'start' | 'stop' | 'restart';

export interface VoiceStep {
  readonly state: VoiceState;
  readonly effect: VoiceEffect;
}

export const VOICE_IDLE: VoiceState = { kind: 'idle' };

/** Whether the microphone is, or is about to be, open. */
export function isVoiceActive(state: VoiceState): boolean {
  return state.kind === 'starting' || state.kind === 'listening';
}

export function reduceVoice(state: VoiceState, event: VoiceEvent): VoiceStep {
  const step = transition(state, event);
  assert(step.effect !== 'start' || step.state.kind === 'starting', 'reduceVoice: a start effect enters starting');
  assert(step.effect !== 'stop' || step.state.kind === 'stopping', 'reduceVoice: a stop effect enters stopping');
  assert(step.state.kind !== 'listening' || step.state.restarts <= VOICE_LIMITS.restartsMax, 'reduceVoice: restarts stay within the bound');
  return step;
}

const stay = (state: VoiceState): VoiceStep => ({ state, effect: 'none' });
const stopping: VoiceStep = { state: { kind: 'stopping' }, effect: 'stop' };

function transition(state: VoiceState, event: VoiceEvent): VoiceStep {
  switch (event.kind) {
    case 'press':
      return onPress(state, event.atMs);
    case 'release':
      return onRelease(state, event.atMs);
    case 'stop':
      return isVoiceActive(state) ? stopping : stay(state);
    case 'started':
      return state.kind === 'starting' ? stay({ kind: 'listening', latch: state.latch, pressedAtMs: state.pressedAtMs, restarts: 0 }) : stay(state);
    case 'failed':
      return state.kind === 'starting' ? stay(VOICE_IDLE) : stay(state);
    case 'ended':
      return onEnded(state);
    case 'silence':
      // Only a hands-free session ends by silence: a held button is the person saying "I am still here".
      if (state.kind === 'listening' && state.latch === 'handsfree' && event.silentMs >= VOICE_LIMITS.silenceMsMax) {
        return stopping;
      }
      return stay(state);
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function onPress(state: VoiceState, atMs: number): VoiceStep {
  switch (state.kind) {
    case 'idle':
      return { state: { kind: 'starting', latch: 'pending', pressedAtMs: atMs }, effect: 'start' };
    case 'starting':
    case 'listening':
      // A press while the button is already down is a repeat; a press in a latched session ends it.
      return state.latch === 'handsfree' ? stopping : stay(state);
    case 'stopping':
      return stay(state);
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function onRelease(state: VoiceState, atMs: number): VoiceStep {
  if ((state.kind !== 'starting' && state.kind !== 'listening') || state.latch !== 'pending') {
    return stay(state);
  }
  const heldMs = atMs - state.pressedAtMs;
  assert(heldMs >= 0, 'onRelease: a button is released after it was pressed');
  if (heldMs >= VOICE_LIMITS.holdMsMin) {
    // Push to talk: letting go is the end. If the recognizer is still starting, it ends as soon as it has.
    return stopping;
  }
  return stay({ ...state, latch: 'handsfree' });
}

function onEnded(state: VoiceState): VoiceStep {
  if (state.kind !== 'listening') {
    return stay(VOICE_IDLE);
  }
  // The recognizer ends itself after a pause; a session the person has not ended listens again, up to the bound.
  if (state.restarts < VOICE_LIMITS.restartsMax) {
    return { state: { ...state, restarts: state.restarts + 1 }, effect: 'restart' };
  }
  return stay(VOICE_IDLE);
}
