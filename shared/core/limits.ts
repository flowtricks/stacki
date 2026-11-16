// Every bound in the contract layer lives here (AGENTS.md §10). Parsers
// enforce them at the boundary; hitting one is a parse failure, never silent
// truncation.
//
// Stacki has NO product size limit: a page, a file or a project of any size
// opens and edits (owner requirement). A bound below is therefore one of two
// things. Either it is the platform's real ceiling (PLATFORM_LIMITS, stated
// once, with its reason), or it is structural (nesting depth, the width of a
// name, queue depth), which does not grow with the input. Work that is
// proportional to the input scales by slicing instead: it yields between slices
// and bounds the work of one slice or frame, never the size of the input.

/**
 * The ceilings the runtime itself imposes. Every size and count bound below
 * that is not structural is one of these, so that "how big can a file be" has
 * one answer and one reason.
 */
export const PLATFORM_LIMITS = {
  /**
   * UTF-16 code units in one JavaScript string: V8's maximum string length on
   * 64-bit platforms (2^29 - 24, about 512 MB of ASCII). A page is decoded to
   * one string, so this is the longest page, file or IPC string field there
   * can be. A file's UTF-8 byte length is never smaller than its unit count, so
   * a file within this many bytes always decodes; it is also the largest byte
   * length a read, a write or an intent payload needs to admit.
   */
  stringUnitsMax: 2 ** 29 - 24,
  /**
   * Elements in one JavaScript array: the ECMAScript array length ceiling
   * (2^32 - 1). Every list this code builds (nodes, entries, files, markers,
   * splices) is an array, so no count can honestly be bounded below it.
   */
  arrayLengthMax: 2 ** 32 - 1,
  /**
   * The largest integer a `number` holds exactly. Sums of sizes (bytes of many
   * strings together) are checked against it so an assertion has a number to
   * compare with; no input comes near it.
   */
  safeIntegerMax: Number.MAX_SAFE_INTEGER,
} as const satisfies Record<string, number>;

export const LIMITS = {
  /** Nodes in one page tree: bounded only by what an array holds. */
  treeNodesMax: PLATFORM_LIMITS.arrayLengthMax,
  /** Nesting depth of one page tree. Hand-written markup rarely exceeds 20. */
  treeDepthMax: 64,
  /** Length of a tag or component name. */
  tagNameCharsMax: 128,
  /** Length of a single attribute name or value: bounded only by the string. */
  attrCharsMax: PLATFORM_LIMITS.stringUnitsMax,
  /** Attributes on one tag. */
  attrsPerNodeMax: PLATFORM_LIMITS.arrayLengthMax,
  /** Text/comment/raw payload of one node, in UTF-16 code units. */
  nodeValueCharsMax: PLATFORM_LIMITS.stringUnitsMax,
  /** Entries of each kind in a project scan (pages, layouts, components). */
  scanEntriesMax: PLATFORM_LIMITS.arrayLengthMax,
  /** Folders listed by a project scan. */
  scanFoldersMax: PLATFORM_LIMITS.arrayLengthMax,
  /** Props on one component schema. */
  propSchemaFieldsMax: 512,
  /** Literal options on one union-typed prop. */
  propOptionsMax: 256,
  /**
   * Levels of item fields one List prop declares: its items' fields, the fields
   * of a list or group among them, and the fields of one more inside that. A
   * field on the last level is a plain value. The Properties panel draws one
   * nested editor per level, and the prop model reads them back
   * (PROP_MODEL_LIMITS.propNestingDepthMax counts each list and group twice).
   */
  listFieldDepthMax: 3,
  /** Item fields on one level of a List prop's item. */
  listFieldsPerLevelMax: 24,
  /** Item fields on every level of one List prop together. */
  listFieldsTotalMax: 96,
  /** Choices of one Option item field. */
  listOptionsMax: 32,
  /** Import declarations in one frontmatter block. */
  importsMax: PLATFORM_LIMITS.arrayLengthMax,
  /** Length of one IPC payload string field: the longest string there is. */
  ipcFieldCharsMax: PLATFORM_LIMITS.stringUnitsMax,
  /** Length of one path crossing a boundary: Windows' extended-length limit. */
  ipcPathCharsMax: 32_768,
  /** Items in one array or keys in one object crossing a boundary. */
  ipcItemsMax: PLATFORM_LIMITS.arrayLengthMax,
  /** Nesting depth of one structured value crossing a boundary. */
  ipcDepthMax: 128,
  /** Characters one syntax-colouring slice tokenises before it yields to the event
   * loop. TextMate and Lezer work is synchronous CPU, so this bounds the work of
   * one slice (about 30 ms of TextMate work), never the size of the text: a page of any length is
   * coloured slice by slice. */
  syntaxHighlightSliceCharsMax: 16_000,

  // Editor core (plan §8). The projection reuses treeNodesMax and treeDepthMax:
  // a projected node is a page-tree node, so one name keeps one meaning.
  /** Bytes of one source file. Merged up from electron/lib/mainLimits.ts so the
   * renderer, the actor and the disk readers answer to one number. It is the
   * platform string ceiling: UTF-8 bytes are never fewer than UTF-16 units, so
   * every file within it decodes. */
  sourceBytesMax: PLATFORM_LIMITS.stringUnitsMax,
  /** Intents accepted by one document actor and not yet terminal. Past this,
   * submission returns `backpressured`; the persistence layer holds the draft. */
  intentsPendingMax: 64,
  /** Work units an exact diff may spend BEYOND the linear scans every diff
   * pays (four passes over both files), and each span mapping through it: one
   * unit is one byte comparison or one frontier cell (shared/engine/diff.ts).
   * Not a size limit: a file of any size with a small edit costs only its
   * linear scans, which the allowance covers. It is the point where an exact
   * minimum script stops being worth its cost (quadratic blow-ups on
   * repetitive content); past it the diff DEGRADES to the blocks it can prove
   * equal (shared/engine/coarseDiff.ts) and nothing is refused. */
  diffWorkMax: 50_000_000,
  /** Edit distance (bytes deleted plus bytes inserted) an exact diff searches
   * to. The frontiers it keeps grow with its square: 2·(D + 1)² 32-bit cells,
   * about 34 MB at this bound, so this is a memory ceiling on the exact
   * algorithm, not on the file. A change larger than this degrades to a coarse
   * diff (see diffWorkMax); a span inside an unchanged block still maps. */
  diffDistanceMax: 2_048,
  /** Document actors one host caches (electron/documents/documentActors.ts).
   * A cache size, not a limit: an actor holds only its snapshot between
   * intents, so the least recently used idle ones are dropped past this and
   * re-read the disk on their next intent. A batch of any number of files runs;
   * the count only decides how much stays in memory. */
  documentActorsMax: 512,
  /** Snapshot bytes all of one host's actors cache together; past it, idle
   * actors are dropped least recently used first. A single document of any
   * size still opens and edits: it is simply not kept once it is idle. */
  documentBytesRetainedMax: 64 * 1024 * 1024,
  /** Parses one actor may have in flight: the current read plus one newer. */
  parseTasksInFlightMax: 2,
  /** Snapshots one actor retains: the committed one plus the candidate under
   * verification. Pending intents keep only their authored preconditions. */
  snapshotsRetainedMax: 2,
  /** Earlier snapshots a host keeps per actor (step 6): the bytes the renderer
   * authored an edit against, once the actor's own writes or an outside one
   * replaced them. The renderer keeps authoring against the page it shows
   * until a save lands with nothing newer typed, so a run of saves under a
   * busy keyboard needs as many as the commit log holds. This is the depth of
   * a cache of history, not a size: an edit authored before the oldest kept
   * snapshot is refused, never guessed, and the page asks to be reloaded. */
  authoredSnapshotsMax: 16,
  /** Bytes of those earlier snapshots per actor, so sixteen copies of a large
   * page never pile up; the oldest go first, but the newest always stays, so a
   * document bigger than this still has the snapshot its next edit needs. */
  authoredBytesRetainedMax: 16 * 1024 * 1024,
  /** Commits a host remembers per actor — the bytes before, the bytes after,
   * the splices between — so an edit authored before the actor's own recent
   * writes is rebased exactly, without a diff (shared/engine/rebase.ts). */
  commitLogEntriesMax: 16,
  /** Undo entries one session keeps (the renderer's history; step 6 moves the
   * bound here from a literal in App.tsx, where it was already 100). */
  undoEntriesMax: 100,
  /** Diagnostics one parse-error projection carries, and the length of each. */
  diagnosticsMax: 64,
  diagnosticCharsMax: 4_096,
} as const satisfies Record<string, number>;
