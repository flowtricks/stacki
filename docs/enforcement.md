# Enforcement

AGENTS.md states the rules; this page says which machine holds each one, so a reader can tell a
rule that cannot be broken from one that relies on review. Everything below runs the same way for
a person, for Claude Code, for Codex, and for Pi, because every gate calls the same code.

## Gates

| Gate | When | What runs | Can it be skipped? |
|---|---|---|---|
| Agent pre-tool | Before an agent runs a command or edits a file | `scripts/agent/core.mts` verdicts | No: refusals come from the harness |
| Agent post-tool | After an agent edits a file | Prettier (writes), policy scan, ESLint on the file | No |
| Agent stop | When an agent tries to finish | Changed-file formatting, scan and lint; all Desktop compiler targets and test source paths | After 3 refusals for the same findings the session may end, and the human is told; new findings start a new round |
| `pre-commit` | `git commit` | Prettier check, scan, ESLint on staged files | `--no-verify`, which agent hooks refuse |
| `commit-msg` | `git commit` | Typed subject ≤ 72 characters, blank line, body | As above |
| Local development | `npm run dev` or `npm run check:local` | All Desktop compiler targets, full lint, formatting, policy, test source paths, Studio static checks | Run directly at any time |
| `pre-push` | `git push` | Full CI gate: clean builds, Desktop and Studio static checks and tests; a pushed version tag (`refs/tags/v<digit>…`) then runs the Linux preflight | As above |
| CI (`npm test`) | Every pull request and push to `main` | Builds, `tsc` (app and scripts), ESLint, Prettier, scan, every test | **No**, once `main` requires the `Check` workflow |

The adapters are thin: `.claude/settings.json` and `.codex/hooks.json` call
`scripts/agent/{claude,codex}.mts`; `.pi/extensions/stacki-policy/` imports the same modules. Git
hooks live in `.githooks/` and are installed by `npm install` (`scripts/policy/installGitHooks.mts`).

Commands for people and agents:

- `npm run check:changed` — what the stop hook runs. Use it before you finish.
- `npm run check:local` — fast, repository-wide checks before starting development.
  `npm run dev` runs these automatically before building and launching the app.
- `npm run typecheck` — checks the root, scripts, contracts, Electron, preload and preview
  compiler configurations with separate incremental caches. The broad root program alone
  cannot catch differences in the build targets' library and module settings.
- `npm run check:policy` — the repository policy scan.
- `npm run lint`, `npm run typecheck`, `npm run format` — the individual tools.
- `env -u ELECTRON_RUN_AS_NODE npm test` — the full gate CI runs.
- `env -u ELECTRON_RUN_AS_NODE npm test -- <suite or folder/>` — only the named suites, for
  iterating. It builds over the existing tree (incrementally) and skips the clean and the
  whole-tree static checks, so it is no substitute for `check:changed` or the full gate
  (`scripts/gate/gatePlan.ts`).

The push hook compiles the test runner and runs the full gate, with live output and a 30-minute
limit per command. It clears `ELECTRON_RUN_AS_NODE` for its children so agent terminals do not
silently run browser probes as Node programs. A failed build or test stops the push. This costs
several minutes, but catches local regressions before GitHub starts a release. CI still checks
clean dependency installation and all three operating systems; local checks cover the host OS.

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
| Prettier, width 160 | CI: `prettier --check` (a width target, not a limit: no check holds line width) |

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
| 17 | Descriptive commit messages | hook: `commit-msg` |
| — | No `@ts-nocheck`; `@ts-expect-error` says why | scan: `no-ts-nocheck`; lint: `ban-ts-comment` |
| — | Code display: code in the UI is syntax highlighted | test: `test/renderer/ui/codeDisplayRule.test.js` (source scan with named allowlists); `test/renderer/ui/codeBlock.test.js` for each site; review for code that looks like a label |
| — | Dropdowns: the custom dropdown, never a native `<select>` | lint: `stacki/no-native-select` (JSX `<select>` and `createElement('select')`) in `src/` via `eslint.config.mjs`, and in `studio/src/` and `studio/demo/` via `studio/eslint.config.ts`, which loads the vendored rule file |

## Changing a rule

1. Change the rule where it lives (the table above says where), with its test:
   `test/scripts/eslintPlugin/eslintPlugin.test.ts`,
   `test/scripts/policy/policyScan.test.ts`, or `test/scripts/agent/agentPolicy.test.ts`.
2. Update this page and AGENTS.md in the same commit.
3. The commit touches gate files, so an agent needs a human's approval to make it.
