// The bounds of the AI chat panel (AGENTS.md §10), kept beside the code that
// enforces them rather than in shared/core/limits.ts, which is a gate file.
// Every queue, buffer, collection and retry the panel owns is capped here, and
// each parser in shared/properties/ai/ checks its share at the boundary.

export const AI_LIMITS = {
  /** One JSON-RPC line from an adapter. A diff of a large file arrives whole in one line. */
  lineBytesMax: 8 * 1024 * 1024,
  /** Requests Stacki has sent to one adapter and not yet heard back about. */
  pendingRequestsMax: 64,
  /** How long an adapter may take to answer a control request (initialize, session/new, set_mode). */
  requestMsMax: 60_000,
  /** How long one prompt turn may run before Stacki cancels it. */
  turnMsMax: 60 * 60 * 1000,
  /** Restarts of a crashed adapter before Stacki gives up until the person asks again. */
  restartsMax: 3,
  /** The first restart's delay; each later one doubles it. */
  restartDelayMsMin: 500,
  /** An adapter with no turn running is stopped after this long. */
  idleMsMax: 15 * 60 * 1000,
  /** Adapter processes alive at once: two agents in the open project, with room for one being replaced. */
  processesMax: 4,
  /** How often batched session events go to the renderer. */
  eventBatchMs: 33,
  /** Unacknowledged event characters above which an adapter's output stops being read. */
  flowHighWatermark: 100_000,
  /** Unacknowledged event characters below which reading resumes. */
  flowLowWatermark: 5_000,
  /** Events waiting for the next batch; past it the adapter is paused, never the queue grown. */
  eventsQueuedMax: 4_096,
  /** One text chunk, thought or message. */
  textCharsMax: 1_000_000,
  /** One side of a diff, one file's content read or written for an adapter. */
  fileCharsMax: 4_000_000,
  /** Terminal output kept per tool call; older output is dropped from the front. */
  toolOutputCharsMax: 200_000,
  /** A tool call's title, a command's description, an option's name. */
  labelCharsMax: 4_000,
  /** Identifiers from an adapter: session, tool call, option and config ids. */
  idCharsMax: 512,
  /** Content blocks in one tool call. */
  toolContentMax: 64,
  /** Locations named by one tool call. */
  locationsMax: 64,
  /** Plan entries. */
  planEntriesMax: 256,
  /** Slash commands an agent advertises. */
  commandsMax: 512,
  /** Session config options, and choices in one of them. */
  configOptionsMax: 64,
  configChoicesMax: 256,
  /** Permission choices offered for one request. */
  permissionOptionsMax: 16,
  /** Permission requests waiting on the person at once, across chats. */
  permissionsPendingMax: 32,
  /** Chats per project. */
  chatsMax: 500,
  /** Events stored per chat; a chat past it is read only. */
  chatEventsMax: 50_000,
  /** One chat's transcript file. */
  chatBytesMax: 64 * 1024 * 1024,
  /** A chat's title. */
  titleCharsMax: 200,
  /** One prompt the person types. */
  promptCharsMax: 100_000,
  /** Attachments on one prompt, and one image's base64 size. */
  attachmentsMax: 8,
  imageBase64CharsMax: 8 * 1024 * 1024,
  /** Files one turn's change ledger tracks, and the bytes it keeps for them. */
  ledgerFilesMax: 500,
  ledgerBytesMax: 64 * 1024 * 1024,
  /** Turns whose changes are kept for review per chat; older turns are settled as kept. */
  ledgerTurnsMax: 50,
  /** How long a git snapshot of the working tree may take. */
  snapshotMsMax: 30_000,
  /** The adapter install, npm included. */
  installMsMax: 10 * 60 * 1000,
  /** Characters of an adapter's stderr kept for the error a person sees. */
  stderrCharsMax: 16_000,

  // The panel overhaul: sections, queue, mentions, compaction (docs/contracts.md "AI panel").
  /** Prompts held in the renderer while a turn runs; the next one is refused, never silently dropped. */
  queuedPromptsMax: 16,
  /** Named sections of one project's chat list. */
  sectionsMax: 50,
  sectionNameCharsMax: 60,
  /** Mention chips on one prompt; past it the prompt is refused at the parser. */
  mentionsMax: 16,
  /** One mentioned file embedded in a prompt, and all of them together; past either the file travels as a link. */
  mentionFileCharsMax: 100_000,
  mentionTotalCharsMax: 400_000,
  /** The excerpt of a mentioned file kept in the transcript. */
  mentionPreviewCharsMax: 4_000,
  /** The bundled instructions a built-in chip carries (the same bound as an agent task's prompt). */
  mentionBuiltinCharsMax: 60_000,
  /** Files the mention scan looks at, and candidates one query returns. */
  mentionScanFilesMax: 50_000,
  mentionResultsMax: 50,
  /** How long a project's scanned file list is reused before the next query scans again. */
  mentionCacheMs: 10_000,
  /** Projects whose scans are cached at once. */
  mentionCachedProjectsMax: 4,
  /** Skills the mention scan reads, and characters kept of a skill's description. */
  mentionSkillsMax: 500,
  mentionSkillDescriptionCharsMax: 400,
  /** The characters of a query typed after `@`. */
  mentionQueryCharsMax: 200,
  /** Segments (text runs and chips) in one composer draft. */
  composerSegmentsMax: 256,
  /** Drafts kept in browser storage per project. */
  draftsStoredMax: 50,
  /** Parts (text runs and chips) in one prompt. */
  promptPartsMax: 64,
  /** Blocks beyond the parts and attachments that mention expansion may add (links, wrappers). */
  promptBlocksExtraMax: 8,
  /** Background tasks the transcript tracks at once. */
  backgroundTasksMax: 64,
  /** The reason a compaction failed, as far as it is kept and shown (the adapter's text is cut to it). */
  compactionErrorCharsMax: 500,
  /** Compactions remembered per chat. */
  compactionsMax: 256,
  /** Expanded or collapsed states the transcript remembers (in memory). */
  transcriptUiEntriesMax: 2_000,
  /** Sanity ceiling for a context window or the tokens used in it. */
  contextTokensMax: 2_000_000_000,
} as const satisfies Record<string, number>;
