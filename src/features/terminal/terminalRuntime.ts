import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { assert } from '../../../shared/core/assert';
import { acknowledgeTerminalData, onTerminalData, onTerminalExit, resizeTerminal, sendTerminalInput, startTerminal } from './terminalBridge';
import { installTerminalInteractions } from './terminalInteractions';

const SCROLLBACK_LINES_MAX = 10_000;
const SCROLL_BOTTOM_SLACK_LINES = 2;

const TERMINAL_THEME = {
  background: '#111111',
  foreground: '#f5f5f5',
  cursor: '#f5f5f5',
  cursorAccent: '#111111',
  selectionBackground: 'rgba(0, 153, 255, 0.30)',
  black: '#3f3f3f',
  red: '#ff453a',
  green: '#30c158',
  yellow: '#ffd60a',
  blue: '#0099ff',
  magenta: '#bf5af2',
  cyan: '#5ac8fa',
  white: '#d4d4d4',
  brightBlack: '#6b6b6b',
  brightRed: '#ff6961',
  brightGreen: '#63d97f',
  brightYellow: '#ffe45c',
  brightBlue: '#4db8ff',
  brightMagenta: '#d68cf5',
  brightCyan: '#8adcfb',
  brightWhite: '#ffffff',
} as const;

interface TerminalDimensions {
  readonly cols: number;
  readonly rows: number;
}

type ProcessState = { readonly kind: 'idle' | 'starting' | 'failed' } | { readonly kind: 'ready'; readonly size: TerminalDimensions };

interface TerminalRuntimeOptions {
  readonly host: HTMLDivElement;
  readonly terminalId: string;
  readonly projectPath: string;
  readonly autoLaunch: () => string;
  readonly titleChanged: (title: string) => void;
  readonly scrolled: (up: boolean) => void;
}

export class TerminalRuntime {
  private terminal: Terminal | undefined;
  private fitAddon: FitAddon | undefined;
  private ready = false;
  private disposed = false;
  private process: ProcessState = { kind: 'idle' };
  private removeBridgeListeners: () => void = () => undefined;

  public constructor(private readonly options: TerminalRuntimeOptions) {}

  public mount(): () => void {
    assert(!this.disposed, 'A disposed terminal runtime cannot mount');
    assert(this.terminal === undefined, 'A terminal runtime can mount only once');
    const removeInteractions = installTerminalInteractions({
      host: this.options.host,
      terminalId: this.options.terminalId,
      terminal: () => this.terminal,
      disposed: () => this.disposed,
    });
    const observer = new ResizeObserver(() => {
      if (this.terminal) {
        this.fit();
      } else {
        this.initialize();
      }
    });
    const resize = (): void => this.fit();
    observer.observe(this.options.host);
    window.addEventListener('resize', resize);
    this.initialize();
    return () => {
      this.disposed = true;
      this.ready = false;
      observer.disconnect();
      window.removeEventListener('resize', resize);
      removeInteractions();
      this.removeBridgeListeners();
      this.removeBridgeListeners = () => undefined;
      this.terminal?.dispose();
      this.terminal = undefined;
      this.fitAddon = undefined;
    };
  }

  public fit(): void {
    const terminal = this.terminal;
    const fitAddon = this.fitAddon;
    if (!this.ready || !terminal || !fitAddon) {
      return;
    }
    if (this.options.host.offsetWidth === 0 || this.options.host.offsetHeight === 0) {
      return;
    }
    let dimensions: TerminalDimensions | undefined;
    try {
      fitAddon.fit();
      dimensions = fitAddon.proposeDimensions();
    } catch {
      // Xterm can reject a fit between layout and paint; its observer retries.
      return;
    }
    if (!dimensions) {
      return;
    }
    if (dimensions.cols <= 0 || dimensions.rows <= 0) {
      return;
    }
    assert(Number.isSafeInteger(dimensions.cols), 'Terminal column count must be an integer');
    assert(Number.isSafeInteger(dimensions.rows), 'Terminal row count must be an integer');
    this.synchronizeSize(terminal, dimensions);
  }

  private synchronizeSize(terminal: Terminal, dimensions: TerminalDimensions): void {
    switch (this.process.kind) {
      case 'idle':
        this.startProcess(terminal, dimensions);
        return;
      case 'starting':
      case 'failed':
        return;
      case 'ready':
        if (dimensions.cols === this.process.size.cols) {
          if (dimensions.rows === this.process.size.rows) {
            return;
          }
        }
        this.process = { kind: 'ready', size: dimensions };
        void resizeTerminal(this.options.terminalId, dimensions.cols, dimensions.rows);
        return;
    }
  }

  public focus(): void {
    this.terminal?.focus();
  }

  public scrollToBottom(): void {
    this.terminal?.scrollToBottom();
  }

  private initialize(): void {
    if (this.terminal || this.disposed) {
      return;
    }
    const host = this.options.host;
    if (host.offsetWidth === 0 || host.offsetHeight === 0) {
      return;
    }
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
      theme: TERMINAL_THEME,
      scrollback: SCROLLBACK_LINES_MAX,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    this.terminal = terminal;
    this.fitAddon = fitAddon;
    this.open(terminal, host);
    this.installTerminalCallbacks(terminal);
    this.installBridgeListeners(terminal);
  }

  private open(terminal: Terminal, host: HTMLDivElement): void {
    try {
      terminal.open(host);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (this.disposed) {
            return;
          }
          this.ready = true;
          this.fit();
          terminal.focus();
        });
      });
    } catch {
      // A failed renderer must not start a shell with unmeasured dimensions.
    }
  }

  private installTerminalCallbacks(terminal: Terminal): void {
    terminal.onData((data) => sendTerminalInput(this.options.terminalId, data));
    terminal.onTitleChange((title) => {
      if (!this.disposed) {
        this.options.titleChanged(title);
      }
    });
    terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      this.options.scrolled(buffer.baseY - buffer.viewportY > SCROLL_BOTTOM_SLACK_LINES);
    });
  }

  private installBridgeListeners(terminal: Terminal): void {
    const removeData = onTerminalData(({ id, data }) => {
      if (id !== this.options.terminalId || this.disposed) {
        return;
      }
      try {
        terminal.write(data, () => acknowledgeTerminalData(id, data.length));
      } catch {
        // A queued write may race with xterm disposal.
      }
    });
    const removeExit = onTerminalExit(({ id, exitCode }) => {
      if (id !== this.options.terminalId || this.disposed) {
        return;
      }
      const code = exitCode === 0 ? '' : ` with code ${exitCode}`;
      terminal.write(`\r\n\x1b[90m[process exited${code}]\x1b[0m\r\n`);
    });
    this.removeBridgeListeners = () => {
      removeData();
      removeExit();
    };
  }

  private startProcess(terminal: Terminal, dimensions: TerminalDimensions): void {
    assert(this.process.kind === 'idle', 'A terminal process can start only once');
    assert(this.ready, 'The terminal must be laid out before starting its process');
    this.process = { kind: 'starting' };
    // The shell must draw its first prompt using the same grid as xterm. A resize
    // sent before native startup completes can otherwise be rejected and lost.
    void startTerminal({
      id: this.options.terminalId,
      cwd: this.options.projectPath,
      autoLaunch: this.options.autoLaunch(),
      ...dimensions,
    }).then((result) => {
      if (this.disposed) {
        return;
      }
      if (!result.ok) {
        this.process = { kind: 'failed' };
        terminal.writeln(`\r\n\x1b[31mFailed to start terminal: ${result.error}\x1b[0m\r\n`);
      } else if (!result.value.ok) {
        this.process = { kind: 'failed' };
        terminal.writeln(`\r\n\x1b[31m${result.value.error}\x1b[0m\r\n`);
      } else {
        this.process = { kind: 'ready', size: dimensions };
        // Layout may change during native startup. Reconcile it without waiting
        // for the user to resize the window again.
        this.fit();
      }
    });
  }
}
