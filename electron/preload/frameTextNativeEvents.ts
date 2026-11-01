import type { createTextBuffer } from './frameTextBuffer';
import { selectTextOffsets, textSelection } from './frameTextSelection';

interface NativeTextOptions {
  readonly root: HTMLElement;
  readonly nodes: readonly Text[];
  readonly buffer: NonNullable<ReturnType<typeof createTextBuffer>>;
  readonly finish: (action: 'apply' | 'cancel') => void;
}

export function installNativeTextEvents(options: NativeTextOptions): () => void {
  const controller = new AbortController();
  const listener = { capture: true, signal: controller.signal };
  const composing = installCompositionEvents(options, listener);
  const owns = (event: Event) => event.target instanceof Node && options.root.contains(event.target);
  window.addEventListener(
    'keydown',
    (event) => {
      if (owns(event)) {
        nativeTextKey(options, event);
      }
    },
    listener,
  );
  window.addEventListener(
    'beforeinput',
    (event) => {
      if (!owns(event) || !(event instanceof InputEvent)) {
        return;
      }
      event.stopImmediatePropagation();
      if (composing.beforeInput()) {
        return;
      }
      event.preventDefault();
      nativeTextInput(options, event);
    },
    listener,
  );
  window.addEventListener('paste', (event) => nativeTextPaste(options, event), listener);
  window.addEventListener('cut', (event) => nativeTextCut(options, event), listener);
  options.root.addEventListener('blur', () => options.finish('apply'), listener);
  window.addEventListener('blur', () => options.finish('apply'), { signal: controller.signal });
  return () => controller.abort();
}

function installCompositionEvents(options: NativeTextOptions, listener: AddEventListenerOptions) {
  let composing = false;
  let nativePending = false;
  const owns = (event: Event) => event.target instanceof Node && options.root.contains(event.target);
  window.addEventListener(
    'input',
    (event) => {
      if (!owns(event)) {
        return;
      }
      event.stopImmediatePropagation();
      if (!composing || !options.buffer.composition()) {
        if (nativePending) {
          options.buffer.rollbackNative();
        }
        options.finish('cancel');
      }
      nativePending = false;
    },
    listener,
  );
  window.addEventListener(
    'compositionstart',
    (event) => {
      if (owns(event)) {
        composing = !!textSelection(options.nodes) && options.buffer.intact();
        if (!composing) {
          options.finish('cancel');
        }
      }
    },
    listener,
  );
  window.addEventListener(
    'compositionend',
    (event) => {
      if (owns(event)) {
        composing = false;
        const selection = textSelection(options.nodes);
        if (selection && options.buffer.composition()) {
          options.buffer.remember(selection);
        } else {
          options.finish('cancel');
        }
      }
    },
    listener,
  );
  return {
    beforeInput: () => {
      nativePending = composing && !!textSelection(options.nodes) && options.buffer.intact();
      return nativePending;
    },
  };
}

function nativeTextKey(options: NativeTextOptions, event: KeyboardEvent): void {
  event.stopImmediatePropagation();
  if (event.isComposing) {
    return;
  }
  const modifier = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (modifier && key === 'a') {
    event.preventDefault();
    selectTextOffsets(options.nodes, { start: 0, end: options.buffer.length() });
  } else if (modifier && (key === 'z' || key === 'y')) {
    event.preventDefault();
    options.buffer.history(event.shiftKey || key === 'y' ? 'redo' : 'undo');
  } else if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) {
    event.preventDefault();
    options.finish(event.key === 'Escape' ? 'cancel' : 'apply');
  }
}

function nativeTextInput(options: NativeTextOptions, event: InputEvent): void {
  if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
    options.buffer.history(event.inputType === 'historyUndo' ? 'undo' : 'redo');
    return;
  }
  const ranges = event.getTargetRanges();
  if (ranges.length > 1) {
    return;
  }
  // Browser editing ranges may trim collapsed source whitespace for insertText.
  // Preserve the user's explicit selection; only deletion/replacement needs the
  // browser's expanded character or word range.
  const expands = event.inputType.startsWith('delete') || event.inputType === 'insertReplacementText';
  const range = textSelection(options.nodes, expands ? ranges[0] : undefined);
  if (!range) {
    return;
  }
  if (event.inputType.startsWith('delete') && event.inputType !== 'deleteByDrag') {
    options.buffer.replace(range, '');
  } else if (['insertText', 'insertReplacementText'].includes(event.inputType)) {
    if (typeof event.data === 'string') {
      options.buffer.replace(range, event.data);
    }
  } else if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
    options.buffer.replace(range, '\n');
  }
}

function nativeTextPaste(options: NativeTextOptions, event: ClipboardEvent): void {
  if (!(event.target instanceof Node) || !options.root.contains(event.target)) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  const selection = textSelection(options.nodes);
  const text = event.clipboardData?.getData('text/plain');
  if (selection && text !== undefined) {
    options.buffer.replace(selection, text);
  }
}

function nativeTextCut(options: NativeTextOptions, event: ClipboardEvent): void {
  if (!(event.target instanceof Node) || !options.root.contains(event.target)) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  const selection = textSelection(options.nodes);
  if (selection && event.clipboardData) {
    const text = options.nodes.map((node) => node.data).join('');
    event.clipboardData.setData('text/plain', text.slice(selection.start, selection.end));
    options.buffer.replace(selection, '');
  }
}
