// Git objects avoid a second checkout. Builds need room for source, output and dependencies.
export const STUDIO_PUBLISH_LIMITS = {
  filesMax: 100_000,
  directoriesMax: 10_000,
  depthMax: 64,
  sourceBytesMax: 8 * 1024 ** 3,
  hostingBytesMax: 2 * 1024 ** 3,
  fileBytesMax: 100 * 1024 ** 2,
  diskReserveBytes: 1024 ** 3,
  commandTimeoutMs: 600_000,
  commandOutputBytesMax: 1024 ** 2,
} as const;
