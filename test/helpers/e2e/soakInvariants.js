// Goal: the definition of "flawless" for the Style panel, as pure checks over what the recorder
// saw (panelRecorder.js). Each check takes one segment (an action, the frames painted from the
// action until the panel settled, the popover log and the inputs) and returns violations, each
// with an invariant id, a one-line summary and the evidence (frames and log excerpts).
//
// Method: no check reads a clock against a threshold except `latency`, whose budgets are the
// documented per-interaction ones and which reports warnings, not failures. The invariants:
//   popover-closed-itself   a popover closed with no person's reason after it opened
//                           (outside press, canvas press, Escape/Enter/Tab, wheel, window blur)
//   provisional-state       a control painted a state that was neither its state before the
//                           action nor its settled state (plain-before-chip is the named case)
//   flicker                 a control reached its settled state, left it, and came back
//   painted-in-steps        after a switch the panel reached its settled state over several
//                           frames (rows trailing the header, chips arriving late)
//   blank-panel             a frame with the panel's controls gone between two elements
//   count-changed           a filter count changed after its first paint for an element
//   layout-shift            a row whose state did not change moved while nothing above it
//                           changed and the panel did not scroll
//   scroll-jump             the panel's scroll offset changed with no wheel from the person
//   focus-after-click-out   a field held the caret after the person pressed outside it
//   source-written          opening, hovering or closing something changed the project files
//   state-disagrees         after clear/undo/redo the field, label, canvas and file disagree
//   latency                 (warning) a reaction slower than its budget.

const LAYOUT_SHIFT_PX_MAX = 0.5;
const UI_TOGGLE_FRAMES_MAX = 1;
const CANVAS_UPDATE_MS_MAX = 100;
const EVIDENCE_FRAMES_MAX = 8;
const CLOSING_KEYS = new Set(['Escape', 'Enter', 'Tab']);
const CLOSING_INPUTS = new Set(['pointerdown', 'wheel', 'window-blur', 'scroll']);
const CLOSING_ACTIONS = /^(canvas|outside|navigator|wheel|key Escape|key Tab|key Enter|escape|blur|scroll|switch|pick|toggle|press)/;

function controlValue(control) {
  if (control === undefined) {
    return 'absent';
  }
  const chips = control.chips.map((chip) => chip.binding).join('+');
  return `${control.kind}|${chips}|${control.value}|${control.hint}`;
}

function popoverViolations(segment) {
  const found = [];
  for (const event of segment.popovers) {
    if (event.kind !== 'close') {
      continue;
    }
    const inputs = event.inputsSinceOpen.filter((input) => {
      if (input.t < event.openedAt) {
        return false;
      }
      if (CLOSING_INPUTS.has(input.type)) {
        return true;
      }
      return input.type === 'keydown' && CLOSING_KEYS.has(input.key);
    });
    const notes = event.notesSinceOpen.filter((note) => note.kind === 'action' && CLOSING_ACTIONS.test(note.action) && note.t >= event.openedAt);
    if (inputs.length === 0 && notes.length === 0) {
      found.push({
        invariant: 'popover-closed-itself',
        summary: `${event.what} closed ${Math.round(event.t - event.openedAt)} ms after opening with no person's reason (${event.removed ? 'unmounted' : 'hidden'})`,
        evidence: { close: event, action: segment.action },
      });
    }
  }
  return found;
}

// Controls compared across a switch: everything the snapshot names, by key.
function controlKeys(frames) {
  const keys = new Set();
  for (const frame of frames) {
    for (const key of Object.keys(frame.controls ?? {})) {
      keys.add(key);
    }
  }
  return [...keys];
}

function excerpt(frames, key) {
  return frames
    .slice(0, EVIDENCE_FRAMES_MAX)
    .map((frame) => ({ frame: frame.frame, t: frame.t, element: frame.element, value: controlValue(frame.controls?.[key]) }));
}

// How long a wrong state stayed on screen: from its first frame to the next frame showing the
// settled state (or the last frame, when it never came back).
function shownForMs(frames, key, wrongFrame, settled) {
  const start = frames.indexOf(wrongFrame);
  const back = frames.slice(start + 1).find((frame) => controlValue(frame.controls?.[key]) === settled);
  const end = back ?? frames[frames.length - 1];
  return Math.round(end.t - wrongFrame.t);
}

function stateViolations(segment) {
  const found = [];
  const frames = segment.frames.filter((frame) => frame.panel);
  if (frames.length === 0 || segment.before === undefined || !segment.before.panel) {
    return found;
  }
  const finalFrame = frames[frames.length - 1];
  const blank = segment.frames.filter((frame) => !frame.panel || Object.keys(frame.controls ?? {}).length < 3);
  if (blank.length > 0 && segment.before.element !== finalFrame.element) {
    found.push({
      invariant: 'blank-panel',
      summary: `the panel painted ${blank.length} frame(s) with no controls between ${segment.before.element} and ${finalFrame.element}`,
      evidence: {
        frames: blank
          .slice(0, EVIDENCE_FRAMES_MAX)
          .map((frame) => ({ frame: frame.frame, t: frame.t, element: frame.element ?? '', controls: Object.keys(frame.controls ?? {}).length })),
      },
    });
  }
  const full = frames.filter((frame) => Object.keys(frame.controls ?? {}).length >= 3);
  const transitionFrames = new Set();
  for (const key of controlKeys(full)) {
    // The field being typed into shows each keystroke: those states are the person's own.
    if (key === segment.action.editedKey) {
      continue;
    }
    const before = controlValue(segment.before.controls?.[key]);
    const settled = controlValue(finalFrame.controls?.[key]);
    let reachedSettled = false;
    let reported = false;
    for (const frame of full) {
      const value = controlValue(frame.controls?.[key]);
      if (value === settled) {
        if (!reachedSettled && settled !== before) {
          transitionFrames.add(frame.frame);
        }
        reachedSettled = true;
        continue;
      }
      if (reported) {
        continue;
      }
      if (reachedSettled) {
        reported = true;
        found.push({
          invariant: 'flicker',
          summary: `${key} left its settled state ${settled} for ${value} and came back after ${shownForMs(full, key, frame, settled)} ms`,
          evidence: { key, frames: excerpt(full, key) },
        });
      } else if (value !== before) {
        reported = true;
        const settledKind = finalFrame.controls?.[key]?.kind;
        const shownKind = frame.controls?.[key]?.kind;
        const named = settledKind === 'chip' && shownKind !== 'chip' ? ' (plain-before-chip)' : '';
        found.push({
          invariant: 'provisional-state',
          summary: `${key} painted ${value} for ${shownForMs(full, key, frame, settled)} ms before settling on ${settled}${named} (element ${frame.element})`,
          evidence: { key, before, settled, frames: excerpt(full, key) },
        });
      }
    }
  }
  if (segment.action.kind === 'switch' && transitionFrames.size > 1) {
    const ordered = [...transitionFrames].sort((left, right) => left - right);
    const times = full.filter((frame) => transitionFrames.has(frame.frame)).map((frame) => frame.t);
    found.push({
      invariant: 'painted-in-steps',
      summary: `the switch to ${finalFrame.element} reached its settled state in ${ordered.length} steps over ${Math.round(Math.max(...times) - Math.min(...times))} ms`,
      evidence: { frames: ordered.slice(0, EVIDENCE_FRAMES_MAX) },
    });
  }
  const sameElement = full.filter((frame) => frame.element === finalFrame.element);
  if (sameElement.length > 0) {
    const firstCounts = JSON.stringify(sameElement[0].counts);
    const changed = sameElement.find((frame) => JSON.stringify(frame.counts) !== firstCounts);
    if (changed !== undefined) {
      found.push({
        invariant: 'count-changed',
        summary: `filter counts changed after first paint: ${firstCounts} -> ${JSON.stringify(changed.counts)}`,
        evidence: { frame: changed.frame },
      });
    }
  }
  return found;
}

function layoutViolations(segment) {
  const found = [];
  const frames = segment.frames.filter((frame) => frame.panel && Object.keys(frame.controls ?? {}).length >= 3);
  const wheeled = segment.inputs.some((input) => input.type === 'wheel') || segment.notes.some((note) => /wheel|scroll/.test(note.action ?? ''));
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1];
    const current = frames[index];
    if (previous.scrollTop !== current.scrollTop) {
      // Scroll anchoring moves scrollTop to keep the rows where they were when content above
      // them changes: no jump on screen. A jump is the rows moving under the person.
      const rowsMoved = Object.entries(current.controls).some(([key, control]) => {
        const earlier = previous.controls[key];
        return earlier !== undefined && controlValue(earlier) === controlValue(control) && Math.abs(earlier.top - control.top) > LAYOUT_SHIFT_PX_MAX;
      });
      if (!wheeled && rowsMoved) {
        found.push({
          invariant: 'scroll-jump',
          summary: `panel scroll jumped ${previous.scrollTop} -> ${current.scrollTop} with no wheel`,
          evidence: {
            frames: frames.slice(Math.max(0, index - 3), index + 4).map((frame) => ({
              frame: frame.frame,
              t: frame.t,
              element: frame.element,
              scrollTop: frame.scrollTop,
              controls: Object.keys(frame.controls).length,
            })),
          },
        });
      }
      continue;
    }
    // The header (element, selector chips) changing height moves everything below it: content.
    if (previous.headerBottom !== current.headerBottom) {
      continue;
    }
    for (const [key, control] of Object.entries(current.controls)) {
      const earlier = previous.controls[key];
      if (earlier === undefined || controlValue(earlier) !== controlValue(control)) {
        continue;
      }
      if (Math.abs(earlier.top - control.top) <= LAYOUT_SHIFT_PX_MAX) {
        continue;
      }
      const changedAbove = Object.entries(previous.controls).some(
        ([otherKey, other]) => other.top < earlier.top && controlValue(other) !== controlValue(current.controls[otherKey]),
      );
      const appearedAbove = Object.entries(current.controls).some(([otherKey, other]) => other.top < control.top && previous.controls[otherKey] === undefined);
      if (!changedAbove && !appearedAbove) {
        found.push({
          invariant: 'layout-shift',
          summary: `${key} moved ${earlier.top} -> ${control.top} px with nothing above it changing`,
          evidence: { frames: [previous.frame, current.frame], element: current.element },
        });
        break;
      }
    }
  }
  return found;
}

function latencyWarnings(segment) {
  const warnings = [];
  const actionNote = segment.notes.find((note) => note.kind === 'action' && note.action === segment.action.label);
  if (actionNote === undefined) {
    return warnings;
  }
  const beforeKey = JSON.stringify({ ...segment.before, popovers: undefined, active: undefined });
  const firstChange = segment.frames.find(
    (frame) => frame.t > actionNote.t && JSON.stringify({ ...frame, frame: undefined, t: undefined, popovers: undefined, active: undefined }) !== beforeKey,
  );
  const firstPopover = segment.frames.find((frame) => frame.t > actionNote.t && frame.popovers.length > (segment.before.popovers?.length ?? 0));
  if (segment.action.kind === 'open' && firstPopover !== undefined && firstPopover.frame - actionNote.frame > UI_TOGGLE_FRAMES_MAX + 1) {
    warnings.push({
      invariant: 'latency',
      summary: `${segment.action.label}: popover appeared ${firstPopover.frame - actionNote.frame} frames after the press`,
      evidence: {},
    });
  }
  if (segment.action.kind === 'switch' && firstChange !== undefined && firstChange.t - actionNote.t > CANVAS_UPDATE_MS_MAX) {
    warnings.push({
      invariant: 'latency',
      summary: `${segment.action.label}: first panel change ${Math.round(firstChange.t - actionNote.t)} ms after the press`,
      evidence: {},
    });
  }
  return warnings;
}

/** All violations (failures) and warnings for one recorded segment. */
function checkSegment(segment) {
  // A hover preview changes the hovered field on purpose; what it must not do is stick, which
  // the hover scenario checks after each way out.
  const stateful = segment.action.kind === 'preview' ? [] : [...stateViolations(segment), ...layoutViolations(segment)];
  const violations = [...popoverViolations(segment), ...stateful];
  return { violations, warnings: latencyWarnings(segment) };
}

module.exports = { checkSegment, controlValue, LAYOUT_SHIFT_PX_MAX, UI_TOGGLE_FRAMES_MAX, CANVAS_UPDATE_MS_MAX };
