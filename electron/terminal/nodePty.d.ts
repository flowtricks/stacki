// Types for node-pty, whose shipped typings/node-pty.d.ts is never wired into
// package.json. This declares only the surface terminal.ts uses; grow it as
// more is needed, and keep it truthful to node-pty's real API.
declare module 'node-pty' {
  export interface PseudoTerminal {
    onData(handler: (data: string) => void): void;
    onExit(handler: (info: { readonly exitCode: number }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    pause(): void;
    resume(): void;
    readonly pid: number;
    readonly process: string;
  }
  export interface SpawnOptions {
    readonly name?: string;
    readonly cols?: number;
    readonly rows?: number;
    readonly cwd?: string;
    readonly env?: Record<string, string | undefined>;
  }
  export function spawn(shell: string, args: readonly string[], options: SpawnOptions): PseudoTerminal;
}
