import { assert } from '../../../shared/core/assert';
import { STUDIO_LOG_CHARS_MAX } from '../../../shared/ipc/studioProgress';

// Sorting the installer's output into lines worth colouring and lines that are not.
//
// The stream is npm's and the installer's own text, so only shell commands are code
// (AGENTS.md, "Code display"); progress, warnings, errors and notices are a log and
// stay plain. Two shapes count as a command:
//   - npm's script echo. npm prints `> name@version script` (the header, which names
//     the package and script, so it is muted log text) and then `> <command>` (the
//     command that runs, which is the line worth colouring). A `> ` line with no header
//     before it is not trusted to be a command: it stays a log line.
//   - A line the installer itself prefixes with `$ `, which is how it echoes the
//     commands it runs.
// A line too long to colour cheaply stays plain: highlighting work is bounded per line
// as well as per output.

export type InstallOutputLine =
  | { readonly kind: 'command'; readonly prefix: string; readonly text: string }
  | { readonly kind: 'header' | 'log'; readonly text: string }
  | { readonly kind: 'empty' };

/** The most lines one classification returns: the last ones, which are the ones in view while following. */
export const INSTALL_OUTPUT_LINES_MAX = 4_000;
/** The longest line that is coloured. A longer one is shown as plain log text. */
export const INSTALL_OUTPUT_COMMAND_CHARS_MAX = 2_000;

// `> @scope/name@1.2.3 script` or `> name@1.2.3 script`, optionally followed by the working directory.
const NPM_HEADER = /^> (?:@[^\s/@]+\/)?[^\s/@]+@\S+ \S+(?: .*)?$/;

export function classifyInstallOutput(output: string): readonly InstallOutputLine[] {
  assert(typeof output === 'string', 'Installer output is text');
  assert(output.length <= STUDIO_LOG_CHARS_MAX, 'Installer output is within the progress limit');
  const rows = output.split('\n');
  const first = Math.max(0, rows.length - INSTALL_OUTPUT_LINES_MAX);
  const lines: InstallOutputLine[] = [];
  let afterHeader = false;
  // The loop is bounded by the row count, which the output limit bounds.
  for (let index = first; index < rows.length; index += 1) {
    const row = (rows[index] ?? '').replace(/\r$/, '');
    const line = classifyRow(row, { afterHeader });
    afterHeader = line.kind === 'header';
    lines.push(line);
  }
  assert(lines.length <= INSTALL_OUTPUT_LINES_MAX, 'Classified lines stay within the line limit');
  return lines;
}

function classifyRow(row: string, context: { readonly afterHeader: boolean }): InstallOutputLine {
  if (row.trim().length === 0) {
    return { kind: 'empty' };
  }
  if (row.length > INSTALL_OUTPUT_COMMAND_CHARS_MAX) {
    return { kind: 'log', text: row };
  }
  if (NPM_HEADER.test(row)) {
    return { kind: 'header', text: row };
  }
  if (row.startsWith('$ ') && row.length > 2) {
    return { kind: 'command', prefix: '$ ', text: row.slice(2) };
  }
  if (context.afterHeader && row.startsWith('> ') && row.slice(2).trim().length > 0) {
    return { kind: 'command', prefix: '> ', text: row.slice(2) };
  }
  return { kind: 'log', text: row };
}
