import type { Writable } from 'node:stream';

export function finishGitInput(stream: Writable, input: string, failed: () => void): void {
  stream.on('error', () => {
    // A command that needs no input may close its pipe immediately without losing any data.
    if (input.length > 0) {
      failed();
    }
  });
  if (input.length > 0) {
    stream.end(input);
  } else {
    // Even an empty string is a write; send only EOF to avoid racing short-lived Git commands.
    stream.end();
  }
}
