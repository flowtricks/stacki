// Goal: see the Style panel the way a person sees it, one painted frame at a time, without
// changing a line of app code. `installRecorder(webContents)` injects a recorder into the
// renderer; `readRecording(webContents)` drains what it saw as plain JSON.
//
// Method (all of it runs in the page, in `recorderMain` below, serialized with toString):
// - Frames: a requestAnimationFrame loop takes a compact snapshot of the panel at the start of
//   every frame and keeps it only when it differs from the last one kept. The loop's callback
//   is registered during the previous frame, so it runs first: it sees everything tasks
//   committed before the frame, and a change made by another rAF callback one frame late
//   (which can only make a passing state look one frame longer, never hide a wrong one).
// - A snapshot holds the header (element and selector chips, filter counts, breakpoint), each
//   control by its accessible name (kind: chip, hint, token text, plain select, segmented,
//   with chip variable names, chip and label colours and the row's top edge), the panel's
//   scroll offset, document.activeElement, skeleton count and every open popover.
// - Popovers: a MutationObserver on the whole document notes each popover (menu, listbox,
//   dialog, variable picker) appearing and disappearing, with the frame, the time, the inputs
//   since it opened and whether it was removed from the DOM or only hidden.
// - Inputs: capture listeners on window log every trusted pointer, key, wheel and focus event.
//   The driver adds a note before each action it takes (including presses into the canvas,
//   which the panel's document never sees as events).
// Every log is capped (LIMITS below); a full log says so instead of growing.

const POPOVER_SELECTOR = '.embed-editor_varpicker, [role="menu"], [role="listbox"], [role="dialog"]';

function recorderMain(limits, popoverSelector) {
  if (window.__soak !== undefined) {
    return 'already';
  }
  const state = {
    frames: [],
    popovers: [],
    inputs: [],
    notes: [],
    overflow: { frames: false, popovers: false, inputs: false, notes: false },
    frameIndex: 0,
    lastKey: '',
    open: new Map(),
    nextId: 1,
    ids: new WeakMap(),
  };
  const now = () => Math.round(performance.now() * 10) / 10;
  const push = (list, name, value) => {
    if (list.length < limits[name]) {
      list.push(value);
    } else {
      state.overflow[name] = true;
    }
  };
  const idOf = (element) => {
    if (!state.ids.has(element)) {
      state.ids.set(element, state.nextId);
      state.nextId += 1;
    }
    return state.ids.get(element);
  };
  const describe = (element) => {
    if (!(element instanceof Element)) {
      return String(element);
    }
    const label = element.getAttribute('aria-label') || element.getAttribute('title') || '';
    const text = element.childElementCount === 0 ? (element.textContent || '').trim().slice(0, 30) : '';
    const className = typeof element.className === 'string' ? element.className.split(/\s+/).slice(0, 2).join('.') : '';
    return `${element.tagName.toLowerCase()}${className ? '.' + className : ''}${label ? `[${label.slice(0, 40)}]` : ''}${text ? ` "${text}"` : ''}`;
  };
  const visible = (element) => element.isConnected && element.getClientRects().length > 0;
  const panelRoot = () => document.querySelector('.embed-editor_root') ?? undefined;
  // The panel's scroller, found once and kept: an open popover locks the panel (overflow
  // hidden), and searching again by overflow would then find another element and report a
  // scroll jump that never happened on screen.
  let scrollerKept;
  const scrollerOf = (root) => {
    if (scrollerKept !== undefined && scrollerKept.isConnected && scrollerKept.contains(root)) {
      return scrollerKept;
    }
    scrollerKept = undefined;
    for (let node = root, depth = 0; node instanceof Element && depth < limits.scrollAncestorsMax; node = node.parentElement, depth += 1) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
        scrollerKept = node;
        return node;
      }
    }
    return undefined;
  };
  // A control's accessible name: the field's input (aria-label or data-prop for the generic
  // "Value" textareas), the select's button, or the segmented group's label.
  const controlName = (element) => {
    const prop = element.getAttribute('data-prop');
    const label = element.getAttribute('aria-label') || '';
    if (prop) {
      return prop;
    }
    return label || prop || '?';
  };
  const chipsIn = (box) =>
    [...box.querySelectorAll('[data-chip]')].map((chip) => {
      const style = getComputedStyle(chip);
      return { binding: chip.getAttribute('data-binding') || '', background: style.backgroundColor, color: style.color };
    });
  const popupInMotion = (element) => {
    const surface = element.closest('.popup-surface');
    if (surface === null) {
      return false;
    }
    return surface.getAnimations().some((animation) => animation.playState === 'running');
  };
  const controls = (root) => {
    const found = {};
    // `moving`: the control sits in a popup whose own open or close motion is running (a
    // 5 px rise and fade, ui/popup.css). Its position then changes by design, not by layout,
    // so the layout-shift check leaves it out (SP-13 was the spacing editor's field rising).
    const add = (name, element, value) => {
      let key = name;
      for (let suffix = 2; found[key] !== undefined && suffix < limits.duplicateNamesMax; suffix += 1) {
        key = `${name}#${suffix}`;
      }
      found[key] = { ...value, moving: popupInMotion(element) };
    };
    for (const box of root.querySelectorAll('.embed-editor_varconnect')) {
      const field = box.querySelector('input[aria-label], textarea[aria-label], input[data-prop], textarea[data-prop]');
      if (field === null) {
        continue;
      }
      const chips = chipsIn(box);
      const hint = box.querySelector('.embed-editor_varconnect-hint .embed-editor_varconnect-token-name');
      const editor = box.querySelector('[contenteditable="true"]');
      const top = Math.round(box.getBoundingClientRect().top * 2) / 2;
      let kind = 'text';
      if (chips.length > 0) {
        kind = 'chip';
      } else if (hint !== null) {
        kind = 'hint';
      }
      add(controlName(field), box, {
        kind,
        value: field.value ?? field.textContent ?? '',
        text: editor === null ? '' : (editor.textContent || '').trim().slice(0, 60),
        chips,
        hint: hint === null ? '' : hint.textContent,
        top,
      });
    }
    for (const button of root.querySelectorAll('button.u-select-button[aria-label]')) {
      const label = button.querySelector('.u-select-label');
      add(controlName(button), button, {
        kind: 'select',
        value: label === null ? (button.textContent || '').trim().slice(0, 60) : label.textContent,
        text: '',
        chips: [],
        hint: '',
        top: Math.round(button.getBoundingClientRect().top * 2) / 2,
      });
    }
    for (const button of root.querySelectorAll('button.embed-editor_spacing-label[data-prop]')) {
      add(`${button.getAttribute('data-prop')} (spacing)`, button, {
        kind: 'spacing',
        value: (button.textContent || '').trim().slice(0, 40),
        text: '',
        chips: chipsIn(button),
        hint: '',
        top: Math.round(button.getBoundingClientRect().top * 2) / 2,
      });
    }
    for (const group of root.querySelectorAll('[role="group"][aria-label]')) {
      const checked = group.querySelector('[role="radio"][aria-checked="true"]');
      add(`${group.getAttribute('aria-label')} (segments)`, group, {
        kind: group.classList.contains('is-custom') ? 'segmented-custom' : 'segmented',
        value: checked === null ? '' : checked.getAttribute('aria-label') || '',
        text: '',
        chips: chipsIn(group),
        hint: '',
        top: Math.round(group.getBoundingClientRect().top * 2) / 2,
      });
    }
    return found;
  };
  const labels = (root) => {
    const found = {};
    for (const label of root.querySelectorAll('.embed-editor_size-label, .embed-editor_prop-label, .u-field-label')) {
      let key = (label.textContent || '').trim().slice(0, 40);
      for (let suffix = 2; found[key] !== undefined && suffix < limits.duplicateNamesMax; suffix += 1) {
        key = `${(label.textContent || '').trim().slice(0, 40)}#${suffix}`;
      }
      found[key] = getComputedStyle(label).color;
    }
    return found;
  };
  const openPopovers = () => [...document.querySelectorAll(popoverSelector)].filter(visible).map((element) => ({ id: idOf(element), what: describe(element) }));
  const snapshot = () => {
    const root = panelRoot();
    const active = document.activeElement;
    const activeInPanel = root !== undefined && active instanceof Element && root.contains(active);
    if (root === undefined) {
      return { panel: false, active: describe(active), popovers: openPopovers() };
    }
    const scroller = scrollerOf(root);
    const element = root.querySelector('.embed-editor_element-id');
    const breakpoint = root.querySelector('.embed-editor_context-select .u-select-label');
    return {
      panel: true,
      element: element === null ? '' : element.textContent,
      selectors: [...root.querySelectorAll('.embed-editor_selector-chip')].map(
        (chip) => `${chip.getAttribute('aria-pressed') === 'true' ? '*' : ''}${(chip.textContent || '').trim()}`,
      ),
      counts: [...root.querySelectorAll('.embed-editor_selector-filter span')].map((span) => span.textContent),
      breakpoint: breakpoint === null ? '' : breakpoint.textContent,
      headerBottom: (() => {
        const head = root.querySelector('.embed-editor_head');
        return head === null ? 0 : Math.round(head.getBoundingClientRect().bottom * 2) / 2;
      })(),
      scrollTop: scroller === undefined ? 0 : Math.round(scroller.scrollTop),
      skeletons: root.querySelectorAll('[class*="skeleton"]').length,
      active: describe(active),
      activeEditable: activeInPanel && (active.matches('input, textarea') || active.isContentEditable),
      controls: controls(root),
      labels: labels(root),
      popovers: openPopovers(),
    };
  };
  const frame = () => {
    state.frameIndex += 1;
    requestAnimationFrame(frame);
    const shot = snapshot();
    const key = JSON.stringify(shot);
    if (key !== state.lastKey) {
      state.lastKey = key;
      push(state.frames, 'frames', { frame: state.frameIndex, t: now(), ...shot });
    }
  };
  requestAnimationFrame(frame);
  const popoverDelta = () => {
    const current = new Map();
    for (const element of document.querySelectorAll(popoverSelector)) {
      if (visible(element)) {
        current.set(idOf(element), element);
      }
    }
    const observedMs = now();
    for (const [id, element] of current) {
      if (!state.open.has(id)) {
        const anchor = document.querySelector('[aria-expanded="true"]');
        state.open.set(id, { element, t: observedMs, what: describe(element) });
        push(state.popovers, 'popovers', {
          kind: 'open',
          id,
          t: observedMs,
          frame: state.frameIndex,
          what: describe(element),
          anchor: anchor === null ? '' : describe(anchor),
        });
      }
    }
    for (const [id, entry] of state.open) {
      if (!current.has(id)) {
        state.open.delete(id);
        const since = state.inputs.filter((input) => input.t >= entry.t).slice(-limits.inputsPerCloseMax);
        const notes = state.notes.filter((note) => note.t >= entry.t).slice(-limits.inputsPerCloseMax);
        push(state.popovers, 'popovers', {
          kind: 'close',
          id,
          t: observedMs,
          frame: state.frameIndex,
          what: entry.what,
          openedAt: entry.t,
          removed: !entry.element.isConnected,
          inputsSinceOpen: since,
          notesSinceOpen: notes,
          stack: new Error('close observed').stack.split('\n').slice(2, 6).join(' | '),
        });
      }
    }
  };
  new MutationObserver(popoverDelta).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-expanded', 'open'],
  });
  const logInput = (event) => {
    if (!event.isTrusted) {
      return;
    }
    if (event.type === 'pointermove' || event.type === 'mousemove') {
      return;
    }
    const target = event.target instanceof Element ? event.target : undefined;
    const inPopover = target !== undefined && target.closest(popoverSelector) !== null;
    push(state.inputs, 'inputs', {
      t: now(),
      type: event.type,
      key: event.key ?? '',
      target: target === undefined ? String(event.target) : describe(target),
      inPopover,
    });
  };
  for (const type of ['pointerdown', 'pointerup', 'click', 'keydown', 'wheel', 'focusin', 'focusout']) {
    window.addEventListener(type, logInput, true);
  }
  // Scrolls (a person's wheel, or the panel scrolling itself) are logged once per frame: a
  // popover that closes because the panel scrolled has a reason, and the log must show it.
  let scrollLoggedFrame = -1;
  window.addEventListener(
    'scroll',
    (event) => {
      if (scrollLoggedFrame === state.frameIndex) {
        return;
      }
      scrollLoggedFrame = state.frameIndex;
      const target = event.target instanceof Element ? describe(event.target) : 'document';
      push(state.inputs, 'inputs', { t: now(), type: 'scroll', key: '', target, inPopover: false, trusted: event.isTrusted });
    },
    true,
  );
  window.addEventListener('blur', (event) => {
    if (event.target === window) {
      push(state.inputs, 'inputs', { t: now(), type: 'window-blur', key: '', target: 'window', inPopover: false });
    }
  });
  window.__soak = {
    note: (note) => push(state.notes, 'notes', { t: now(), frame: state.frameIndex, ...note }),
    now,
    snapshot,
    frameIndex: () => state.frameIndex,
    drain: () => {
      const out = { frames: state.frames, popovers: state.popovers, inputs: state.inputs, notes: state.notes, overflow: { ...state.overflow } };
      state.frames = [];
      state.popovers = [];
      state.inputs = [];
      state.notes = [];
      state.lastKey = '';
      state.overflow = { frames: false, popovers: false, inputs: false, notes: false };
      return out;
    },
  };
  return 'installed';
}

const LIMITS = Object.freeze({
  frames: 20000,
  popovers: 4000,
  inputs: 20000,
  notes: 20000,
  inputsPerCloseMax: 12,
  duplicateNamesMax: 12,
  scrollAncestorsMax: 30,
});

async function installRecorder(webContents) {
  const source = `(${recorderMain.toString()})(${JSON.stringify(LIMITS)}, ${JSON.stringify(POPOVER_SELECTOR)})`;
  return webContents.executeJavaScript(source);
}

async function readRecording(webContents) {
  return webContents.executeJavaScript('window.__soak.drain()');
}

module.exports = { installRecorder, readRecording, POPOVER_SELECTOR, LIMITS };
