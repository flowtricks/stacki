import type { Terminal } from '@xterm/xterm';
import type { PathStyle } from './terminalPaste';
import { decideTerminalPaste, escapePosixPath, quoteWindowsPath } from './terminalPaste';
import { requestNativePaste, saveTerminalClipboardImage, sendTerminalInput, terminalFilePath, TERMINAL_IMAGE_BYTES_MAX } from './terminalBridge';

interface InteractionOptions {
  readonly host: HTMLDivElement;
  readonly terminalId: string;
  readonly terminal: () => Terminal | undefined;
  readonly disposed: () => boolean;
}

export function installTerminalInteractions(options: InteractionOptions): () => void {
  const pasteImage = (file: File | undefined): void => void persistImage(options, file);
  const onPaste = (event: ClipboardEvent): void => {
    const data = event.clipboardData;
    if (!data) {
      return;
    }
    const action = decideTerminalPaste(Array.from(data.items), data.getData('text/plain'), terminalFilePath, terminalPathStyle());
    if (action.kind === 'text') {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (action.kind === 'paths') {
      options.terminal()?.paste(action.text);
    } else {
      pasteImage(action.file);
    }
  };
  const onDragOver = (event: DragEvent): void => {
    const transfer = event.dataTransfer;
    if (transfer) {
      event.preventDefault();
      transfer.dropEffect = 'copy';
    }
  };
  const onDrop = (event: DragEvent): void => dropIntoTerminal(options, event, pasteImage);
  const onKeyDown = (event: KeyboardEvent): void => handlePasteShortcut(event);
  options.host.addEventListener('keydown', onKeyDown, true);
  options.host.addEventListener('paste', onPaste, true);
  options.host.addEventListener('dragover', onDragOver, true);
  options.host.addEventListener('drop', onDrop, true);
  return () => {
    options.host.removeEventListener('keydown', onKeyDown, true);
    options.host.removeEventListener('paste', onPaste, true);
    options.host.removeEventListener('dragover', onDragOver, true);
    options.host.removeEventListener('drop', onDrop, true);
  };
}

async function persistImage(options: InteractionOptions, file: File | undefined): Promise<void> {
  const forwardPasteKeystroke = (): void => {
    if (!options.disposed()) {
      sendTerminalInput(options.terminalId, '\x16');
    }
  };
  if (!file || file.size > TERMINAL_IMAGE_BYTES_MAX) {
    forwardPasteKeystroke();
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (options.disposed()) {
      return;
    }
    const result = await saveTerminalClipboardImage(bytes, file.type || 'image/png');
    if (options.disposed()) {
      return;
    }
    if (!result.ok || !result.value.ok) {
      forwardPasteKeystroke();
      return;
    }
    const path = result.value.path;
    options.terminal()?.paste(window.avb.platform === 'win32' ? quoteWindowsPath(path) : escapePosixPath(path));
  } catch {
    forwardPasteKeystroke();
  }
}

function dropIntoTerminal(options: InteractionOptions, event: DragEvent, pasteImage: (file: File | undefined) => void): void {
  const data = event.dataTransfer;
  if (!data) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  const plainText = data.getData('text/plain');
  const action = decideTerminalPaste(Array.from(data.items), plainText, terminalFilePath, terminalPathStyle());
  if (action.kind === 'paths') {
    options.terminal()?.paste(action.text);
  } else if (action.kind === 'image') {
    pasteImage(action.file);
  } else if (plainText) {
    options.terminal()?.paste(plainText);
  }
}

function handlePasteShortcut(event: KeyboardEvent): void {
  const wantsPaste =
    window.avb.platform === 'darwin'
      ? event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey
      : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
  if (wantsPaste && event.key.toLowerCase() === 'v') {
    event.preventDefault();
    event.stopImmediatePropagation();
    requestNativePaste();
  }
}

function terminalPathStyle(): PathStyle {
  return window.avb.platform === 'win32' ? 'windows' : 'posix';
}
