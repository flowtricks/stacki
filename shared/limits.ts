// Every bound in the contract layer lives here (AGENTS.md §10). Parsers
// enforce them at the boundary; hitting one is a parse failure, never silent
// truncation. Values are sized against what a real Astro project can hold,
// with headroom, not against what would exhaust memory.

export const LIMITS = {
  /** Nodes in one page tree. A 50k-line page is already a code-view page. */
  treeNodesMax: 20_000,
  /** Nesting depth of one page tree. Hand-written markup rarely exceeds 20. */
  treeDepthMax: 64,
  /** Length of a tag or component name. */
  tagNameCharsMax: 128,
  /** Length of a single attribute name or value. */
  attrCharsMax: 8_192,
  /** Attributes on one tag. */
  attrsPerNodeMax: 256,
  /** Text/comment/raw payload of one node, in UTF-16 code units. */
  nodeValueCharsMax: 1_000_000,
  /** Entries of each kind in a project scan (pages, layouts, components). */
  scanEntriesMax: 10_000,
  /** Folders listed by a project scan. */
  scanFoldersMax: 2_000,
  /** Props on one component schema. */
  propSchemaFieldsMax: 512,
  /** Literal options on one union-typed prop. */
  propOptionsMax: 256,
  /** Import declarations in one frontmatter block. */
  importsMax: 256,
  /** Cap on rescan chain-follows and save drains: both loops converge because
   * each pass needs a strictly newer request; a live cap hit means a bug. */
  rescanChainMax: 256,
  saveDrainMax: 256,
  /** Length of one IPC payload string field. */
  ipcFieldCharsMax: 10_000_000,
  /** TextMate highlighting is synchronous CPU work after grammar startup. */
  syntaxHighlightCharsMax: 1_000_000,
} as const satisfies Record<string, number>;
