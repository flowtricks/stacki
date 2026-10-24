// Optional sequence numbers preserve compatibility with clients/containers from older releases.
export function parseSaveSequence(input: unknown): number | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 1) {
    throw new Error('Invalid save acknowledgment sequence');
  }
  return input;
}
