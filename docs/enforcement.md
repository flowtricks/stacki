# Enforcement

AGENTS.md states the rules; this page says which machine holds each one, so a reader can tell a
rule that cannot be broken from one that relies on review. GitHub Actions verifies the
same repository rules for people and coding agents.

## Gates

| Gate | When | What runs | Can it be skipped? |
|---|---|---|---|
| Agent pre-tool | Before an agent runs a command or edits a file | `scripts/agent/core.mts` verdicts | No: refusals come from the harness |
| Commit messages | Every pull request | Typed subject ≤ 72 characters, blank line, body | GitHub Actions reports failures in the policy job |
| Local development checks | On request with `npm run check:local` | Desktop compiler targets, lint, formatting, policy, test source paths, Studio static checks | Optional |
| Release (`npm run release:ship`) | Every release | GitHub creates the version bump. The release tag requires green `Check` and `Candidate` runs on the exact commit | None: `release.yml` refuses to publish without both proofs |
| Quarantine (`scripts/gate/quarantine.json`) | Every gate run | A listed suite's failure is reported and tolerated only with an owner, a reason, two red run URLs and an expiry at most 7 days after it was added; an expired, invalid or protected (correctness, safety, data-write) entry fails the gate (`scripts/gate/quarantine.ts`) | Renewing an entry needs a new commit with a new reason |
| CI (`npm test -- --shard=k/4`) | Every pull request and push to `main` | Builds, `tsc` (app and scripts), ESLint, Prettier, scan, every test: a desktop static-checks job (`npm test -- --checks=desktop`), a Studio verify job (`--checks=studio`, 25-minute limit) and four test shards per platform, together exactly `npm test` (`scripts/gate/testShard.ts`); `test (<os>)` passes only when all six did | **No**, once `main` requires the `Check` workflow |

Claude Code, Codex, and Pi use a pre-tool guard for changes to protected files.
Commits, pushes, and development launches proceed without running repository checks.
GitHub Actions runs the required checks on the pull request.

Commands for people and agents:

- `npm run check:changed` — optional checks for changed files.
- `npm run check:local` — optional repository-wide checks.
- `npm run typecheck` — checks the root, scripts, contracts, Electron, preload and preview
  compiler configurations with separate incremental caches. The broad root program alone
  cannot catch differences in the build targets' library and module settings.
- `npm run check:policy` — the repository policy scan.
- `npm run lint`, `npm run typecheck`, `npm run format` — the individual tools.
- Files this clone hides from git for itself (`.git/info/exclude`, the global excludes file; a
  local notes folder, say) are skipped by every gate, not only by the scan: ESLint's config ignores
  them (`scripts/policy/gitExcludes.mts`), and Prettier runs over git's file list
  (`scripts/policy/formatTree.mts`, behind `npm run format`, `format:check`, `check:local` and the
  gate) because it walks the folder and reads no exclude list. `.gitignore` and `.prettierignore`
  apply as before, so a clean checkout is checked exactly as it was.
- `env -u ELECTRON_RUN_AS_NODE npm test` — the full gate CI runs.
- `env -u ELECTRON_RUN_AS_NODE npm test -- <suite or folder/>` — only the named suites, for
  iterating. It builds over the existing tree (incrementally) and skips the clean and the
  whole-tree static checks, so it is no substitute for `check:changed` or the full gate
  (`scripts/gate/gatePlan.ts`).

### The gate files

Some files define the gates themselves: `AGENTS.md`, `CLAUDE.md`, `eslint.config.mjs`, the
Prettier config, every `tsconfig*.json`, `scripts/{eslintPlugin,policy,agent}/`, `.githooks/`,
the agent configs, `.github/workflows/`, `shared/core/limits.ts`, and this page. An agent that edits one
— with an edit tool, or with a shell command that writes it — is stopped for a human decision:
Claude Code asks; Codex and Pi refuse and tell the agent to ask. A human who starts an agent with
`STACKI_ALLOW_POLICY_EDITS=1` has approved such edits for that session (the agent cannot set it:
hooks run in the harness's environment, not the agent's shell).

The shell check is a heuristic — a shell can write a file in more ways than any list names — and
the agent hooks are guard rails, not a sandbox. CI is the gate that cannot be argued with.

The command check reads the checkout's own path as data: every spelling a shell accepts for it
(raw, backslash-escaped, inside single or double quotes) is read as `.` before the command is split,
so a root such as `/Users/Lilian's Home/stacki` cannot turn `tee <root>/.claude/settings.json` into
an allow (`withRootAsDot` in `scripts/agent/core.mts`; issue #78).

## Rule map

**Mechanism:** `tsc` = compiler flag; `lint` = ESLint (`stacki/…` rules live in
`scripts/eslintPlugin/`); `scan` = `scripts/policy/scan.mts`; `hook` = agent or git hook;
`review` = people, because no deterministic check exists.

### Non-negotiables

| # | Rule | Mechanism |
|---|---|---|
| 1 | No `any` | lint: `no-explicit-any`, `no-unsafe-*` (assignment, member access, call, return, argument) |
| 2 | No type assertions outside validated constructors | lint: `no-restricted-syntax` (assertion syntax), off only in `shared/` and four named adapters |
| 3 | No `enum` | lint: `stacki/no-enum` |
| 4 | No `Partial<T>` inputs | lint: `stacki/no-partial-parameter` |
| 5 | Boundaries parse before use | lint: `no-unsafe-*` keep `JSON.parse`'s `any` from flowing anywhere; review for parser quality |
| 6 | Immutability by default | lint: `prefer-readonly`, `no-param-reassign` (with properties; exempt only for DOM elements, React refs, canvas contexts, and style declarations, by name); review for `readonly` types |
| 7 | Total functions | tsc: `strict`, `noImplicitReturns`, `noUncheckedIndexedAccess`; review |
| 8 | Two error channels | lint: `only-throw-error`, `no-floating-promises`, `no-misused-promises`; review for channel choice |
| 9 | A limit on everything | lint: `stacki/no-unbounded-loop`, `stacki/bounded-recursion`; review for queues and caches |
| 10 | Assert invariants | scan: assertion density in `shared/` (floor in `scripts/policy/limits.mts`); lint: `stacki/no-compound-assert` |

### Configuration

| Rule | Mechanism |
|---|---|
| Required tsconfig flags | tsc: every `tsconfig*.json`; `scripts/tsconfig.json` adds `verbatimModuleSyntax` for scripts |
| Required ESLint rules | lint: `eslint.config.mjs` is the source of truth |
| Prettier, width 160 | CI: `prettier --check` through `scripts/policy/formatTree.mts` (a width target, not a limit: no check holds line width) |

### Core patterns

| § | Rule | Mechanism |
|---|---|---|
| 1 | Exhaustive unions | lint: `switch-exhaustiveness-check`; tsc: `never` checks |
| 2 | Parse, don't validate | lint (`no-unsafe-*`); tests: one parse test per contract (review) |
| 3 | `catch` binds `unknown` | lint: `stacki/catch-unknown`, `use-unknown-in-catch-callback-variable` |
| 3 | All errors handled | lint: `no-floating-promises`, `no-misused-promises` |
| 4 | Branded lookalikes | review |
| 5 | Constants as types | review |
| 6 | No boolean parameters | lint: `stacki/no-boolean-parameter` (inline callbacks and one-flag setters exempt) |
| 6 | `undefined` for absence | lint: `stacki/no-null` (fixed list of platform calls exempt) |
| 6 | Callbacks last | lint: `stacki/callback-last` |
| 6 | Explicit options at call sites | review |
| 8 | No overloads | lint: `stacki/no-overloads` |
| 9 | Split compound assertions | lint: `stacki/no-compound-assert` |
| 9 | Paired assertions | review |
| 10 | Bounded loops and recursion | lint: `stacki/no-unbounded-loop`, `stacki/bounded-recursion` (direct recursion; mutual recursion is review) |
| 11 | Braces always | lint: `curly` |
| 11 | Simple, positive conditions | review |
| 12 | No abbreviations | lint: `stacki/naming` (word list in `eslint.config.mjs`) |
| 12 | Qualifiers last | lint: `stacki/naming` (`max`/`min` before a quantity) |
| 12 | Good names, one meaning | review |
| 13 | Comments are sentences | lint: `stacki/comment-sentence` (own-line comments: capital, full stop) |
| 13 | Test files open with goal and method | scan: `test-header` (the comment's presence; its content is review) |
| 13 | Every suppression says why | lint: `stacki/require-disable-reason`; scan: `no-blanket-disable` |
| 14 | Division states its rounding | lint: `stacki/division-intent` (where the result is an index or count) |
| 14 | Index, count, size brands | review |
| 15 | Performance | review |
| 16 | File order | review |
| 16 | Renderer layers and feature edges; main-process and contract areas | lint: `stacki/source-layers` (`SOURCE_LAYERS`, `ELECTRON_AREAS`, `SHARED_AREAS` in `eslint.config.mjs`) |
| 12, 16 | Layout names: camelCase folders and modules, PascalCase components, unique per root | scan: `layout-name`, `layout-unique` |
| 13, 16 | Tests mirror the source: suites in `test/<root>/<area>/`, helpers in `test/helpers/` | scan: `test-layout`, `test-mirror` |
| 17 | Dependencies justified | scan: `dependency-record` (`docs/dependencies.md` ↔ `package.json`) |
| 17 | One lockfile | scan: `one-lockfile` |
| 17 | Scripts are TypeScript | scan: `no-shell-script` |
| 17 | Descriptive commit messages | CI: pull request commit message check |
| — | No `@ts-nocheck`; `@ts-expect-error` says why | scan: `no-ts-nocheck`; lint: `ban-ts-comment` |
| — | Code display: code in the UI is syntax highlighted | test: `test/renderer/ui/codeDisplayRule.test.js` (source scan with named allowlists); `test/renderer/ui/codeBlock.test.js` for each site; review for code that looks like a label |
| — | Dropdowns: the custom dropdown, never a native `<select>` | lint: `stacki/no-native-select` (JSX `<select>` and `createElement('select')`) in `src/` via `eslint.config.mjs`, and in `studio/src/` and `studio/demo/` via `studio/eslint.config.ts`, which loads the vendored rule file |
| — | Scroll containers keep a stable scrollbar gutter | test: `test/renderer/ui/scrollGutter.test.ts` (scanner `test/helpers/scrollGutter.ts`, exceptions in `test/helpers/scrollGutterAllowlist.json`) |
| — | Studio's AI chat shows Desktop's components, not copies: the shared menu, diff view, chip editor, sessions list classes and styles reach Studio only through `studio/scripts/shared-source.json`, assembled into `studio/vendor/stacki` | `npm --prefix studio run assemble` fails on a listed file that no longer exists, and `check` and `lint` fail on an adapter that imports one that moved or lost an export; test: `studio/test/chatState.test.ts` (stored history, pin and reorder, mentions), `studio/test/ai.browser.ts` (the panel in a real browser); review for look, since no check compares pixels |

## Changing a rule

1. Change the rule where it lives (the table above says where), with its test:
   `test/scripts/eslintPlugin/eslintPlugin.test.ts`,
   `test/scripts/policy/policyScan.test.ts`, or `test/scripts/agent/agentPolicy.test.ts`.
2. Update this page and AGENTS.md in the same commit.
3. The commit touches gate files, so an agent needs a human's approval to make it.
