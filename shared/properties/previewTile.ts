// The life of one tile in the insert palette, as a state machine: idle, queued, rendering, ready,
// unavailable. A tile that has a picture never goes back to waiting: a refresh happens behind the picture
// it already shows, and one that fails keeps it. That rule is what stops the grid flickering when it scrolls
// or reopens, and it lives here so it can be tested without a browser.

import { assert } from '../core/assert';
import { PREVIEW_SNAPSHOT_LIMITS, type PreviewAttemptLabel } from './previewSnapshot';

/** Why a tile has no picture, specific enough for its tooltip and for a retry that can change the outcome. */
export type TileUnavailable =
  | { readonly kind: 'no-server' }
  | { readonly kind: 'no-file' }
  | { readonly kind: 'needs-props'; readonly names: readonly string[] }
  | { readonly kind: 'threw'; readonly message: string }
  | { readonly kind: 'client-only' }
  | { readonly kind: 'rendered-nothing' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'too-large' };

export type TileUnavailableKind = TileUnavailable['kind'];

export type TileState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'queued' }
  | { readonly kind: 'rendering' }
  | {
      readonly kind: 'ready';
      readonly key: string;
      readonly attempt: PreviewAttemptLabel;
      /** A newer rendering is being made behind this picture; the picture stays until it arrives. */
      readonly refreshing: boolean;
    }
  | { readonly kind: 'unavailable'; readonly reason: TileUnavailable; readonly retried: boolean };

export type TileEvent =
  | { readonly kind: 'enqueue' }
  | { readonly kind: 'start' }
  | { readonly kind: 'rendered'; readonly key: string; readonly attempt: PreviewAttemptLabel }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'failed'; readonly reason: TileUnavailable }
  | { readonly kind: 'retry' };

export const TILE_IDLE: TileState = { kind: 'idle' };

/**
 * The next state. Total: an event that cannot apply (a late answer for a tile that moved on) leaves the
 * state alone instead of throwing, because answers arrive from other processes and may be late. What it
 * never does is take a ready tile back to idle, queued or rendering, or replace its picture with a failure.
 */
export function nextTileState(state: TileState, event: TileEvent): TileState {
  switch (state.kind) {
    case 'idle':
      return fromIdle(state, event);
    case 'queued':
      return fromQueued(state, event);
    case 'rendering':
      return fromRendering(state, event);
    case 'ready':
      return fromReady(state, event);
    case 'unavailable':
      return fromUnavailable(state, event);
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function fromIdle(state: TileState, event: TileEvent): TileState {
  switch (event.kind) {
    case 'enqueue':
      return { kind: 'queued' };
    case 'failed':
      // Known at once, with nothing to render (no server, no file): never queued.
      return { kind: 'unavailable', reason: checkedReason(event.reason), retried: false };
    case 'rendered':
      // A stored snapshot is shown without a render.
      return { kind: 'ready', key: event.key, attempt: event.attempt, refreshing: false };
    case 'start':
    case 'unchanged':
    case 'retry':
      return state;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function fromQueued(state: TileState, event: TileEvent): TileState {
  switch (event.kind) {
    case 'start':
      return { kind: 'rendering' };
    case 'rendered':
      return { kind: 'ready', key: event.key, attempt: event.attempt, refreshing: false };
    case 'failed':
      return { kind: 'unavailable', reason: checkedReason(event.reason), retried: false };
    case 'enqueue':
    case 'unchanged':
    case 'retry':
      return state;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function fromRendering(state: TileState, event: TileEvent): TileState {
  switch (event.kind) {
    case 'rendered':
      return { kind: 'ready', key: event.key, attempt: event.attempt, refreshing: false };
    case 'failed':
      return { kind: 'unavailable', reason: checkedReason(event.reason), retried: false };
    case 'enqueue':
    case 'start':
    case 'unchanged':
    case 'retry':
      return state;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function fromReady(state: Extract<TileState, { readonly kind: 'ready' }>, event: TileEvent): TileState {
  switch (event.kind) {
    case 'enqueue':
      // Checking whether the picture is current: the picture stays.
      return { ...state, refreshing: true };
    case 'start':
      return state.refreshing ? state : { ...state, refreshing: true };
    case 'rendered':
      return { kind: 'ready', key: event.key, attempt: event.attempt, refreshing: false };
    case 'unchanged':
      return { ...state, refreshing: false };
    case 'failed':
      // A refresh that fails keeps the picture it has: a stale tile is better than a missing one.
      return { ...state, refreshing: false };
    case 'retry':
      return state;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function fromUnavailable(state: Extract<TileState, { readonly kind: 'unavailable' }>, event: TileEvent): TileState {
  switch (event.kind) {
    case 'retry':
      return { kind: 'queued' };
    case 'enqueue':
      // A tile that is known to fail is not asked again until the person retries or the project changes.
      return state;
    case 'rendered':
      return { kind: 'ready', key: event.key, attempt: event.attempt, refreshing: false };
    case 'start':
    case 'unchanged':
    case 'failed':
      return state;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function checkedReason(reason: TileUnavailable): TileUnavailable {
  switch (reason.kind) {
    case 'needs-props':
      assert(reason.names.length > 0, 'A needs-props reason names the props');
      return reason;
    case 'threw':
      assert(reason.message.length > 0, 'A threw reason carries the message');
      return { kind: 'threw', message: reason.message.slice(0, PREVIEW_SNAPSHOT_LIMITS.reasonCharsMax) };
    case 'no-server':
    case 'no-file':
    case 'client-only':
    case 'rendered-nothing':
    case 'timeout':
    case 'too-large':
      return reason;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/**
 * What the tile draws. A picture wins over everything else, and a tile that has no picture yet shows a
 * skeleton the size of the final tile and never the words "No preview available", which only a tile that
 * is known to have none (unavailable) may say.
 */
export type TileView = 'picture' | 'skeleton' | 'unavailable';

export function tileView(state: TileState): TileView {
  switch (state.kind) {
    case 'ready':
      return 'picture';
    case 'idle':
    case 'queued':
    case 'rendering':
      return 'skeleton';
    case 'unavailable':
      return 'unavailable';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

/**
 * Reads the reason a preview page gives in words (its `empty` message) as a typed reason, so a tile can
 * name the cause in the person's language. Anything it does not recognise is kept as the page's own words.
 */
export function readPageReason(text: string): TileUnavailable {
  const needs = /^Preview needs data for: (.+?)\.(?: |$)/.exec(text);
  const captured = needs?.[1];
  if (captured !== undefined) {
    const names = captured
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    if (names.length > 0) {
      return { kind: 'needs-props', names: names.slice(0, 16) };
    }
  }
  if (/^Threw: /.test(text)) {
    return { kind: 'threw', message: text.slice('Threw: '.length) || text };
  }
  if (/client-only/i.test(text)) {
    return { kind: 'client-only' };
  }
  return { kind: 'rendered-nothing' };
}
