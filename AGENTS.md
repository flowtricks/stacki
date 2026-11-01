# AGENTS.md — TypeScript Standards

## Design goals

**Safety, performance, and developer experience — in that order.** Every rule in
this document exists to serve one of those goals; style is not taste. These rules
make invalid states **unrepresentable**, move failures to compile time or to
system boundaries, and make the failures that remain **loud**. They are
language-canonical: no framework, runtime, or platform assumptions. Follow them
when writing or editing code in this repository.

We operate a **zero-technical-debt** policy: do it right the first time, because
the second time may not transpire, and a problem solved in design is many times
cheaper than one solved in production. When a rule conflicts with existing code,
prefer the rule and refactor the old code when touched.

**Always say why.** When a rule, a decision, or a piece of code needs a
rationale, write the rationale — in this document, in comments, in commit
messages. A stated reason lets the reader evaluate the decision, not just obey
it.

## Non-negotiables

1. **No `any`.** Use `unknown` and narrow.
2. **No type assertions (`as T`, `<T>x`) on data you don't fully control.**
   Assertions are permitted only inside a validated constructor or type guard.
3. **No `enum`.** Use string-literal unions + `as const`.
4. **No `Partial<T>` on function inputs.** Use explicit `Pick<>` types.
5. **Every value crossing a boundary (network, file, env, user input,
   `JSON.parse`) is parsed and validated before use** — never cast and trust.
6. **Immutability by default**: `readonly` properties, `ReadonlyArray<T>`,
   `as const`. Mutation must be local, centralized, and justified (§11).
7. **Functions are total where possible**: every declared input type produces a
   declared output — absence and failure are part of the return type.
8. **Two error channels, never mixed**: expected operating failures are values
   (`Result`); programmer errors are assertions that crash (§9).
9. **Put a limit on everything.** Every loop, queue, retry, and collection has
   a stated upper bound (§10).
10. **Assert invariants.** Preconditions, postconditions, and invariants are
    checked at runtime; core logic averages at least two assertions per
    function (§9).

## tsconfig (required flags)

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "verbatimModuleSyntax": true
  }
}
```

## ESLint (required rules)

`eslint.config.mjs` is the source of truth; a copy here would drift from it.
It holds, at minimum: `no-explicit-any`, the `no-unsafe-*` family, a ban on
type-assertion syntax outside validated constructors, `prefer-readonly`,
`switch-exhaustiveness-check`, and `curly: all`.
The rules below that stock ESLint cannot express live in the local plugin,
`scripts/eslintPlugin/`.

Formatting: Prettier with `printWidth: 160`. Prettier wraps what it can; a line it
cannot wrap (a long string, URL or comment) may run past 160 columns. No check
holds line width, function length or file length.

## Enforcement

These rules are checked by machines wherever a machine can check them, and
the same checks run for people and for every coding agent (Claude Code, Codex,
Pi). `docs/enforcement.md` maps each rule to the check that holds it and lists
the rules that remain for review.

- Agent hooks format and check each file you edit, and check every changed
  file before you finish. Fix what they report; do not work around them.
- `npm run check:changed` runs the finish check by hand. Run it before you
  say you are done.
- `npm run check:local` runs fast repository-wide checks before `npm run dev`.
  All Desktop compiler targets and test source paths also run at agent finish,
  because config changes and deleted files can break unchanged callers.
- Git hooks check staged files, commit messages, and pushes. Never skip them
  (`--no-verify`); the agent hooks refuse it, and CI runs the same checks.
- Pushes run the full clean-build and regression gate locally so passing
  TypeScript alone cannot send a known test failure to GitHub.
- The files that define the gates (this file, lint and compiler configs,
  `scripts/{eslintPlugin,policy,agent}/`, hook configs, `shared/core/limits.ts`)
  change only with a human's approval.

---

## Core patterns

### 1. Discriminated unions + exhaustive handling

Model state as a union where data exists **only in the states that have it** —
never parallel optional fields and booleans.

```ts
export type LoadState<T> =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: T };

export function renderState<T>(s: LoadState<T>, render: (d: T) => string): string {
  switch (s.kind) {
    case "idle":    return "";
    case "loading": return "…";
    case "error":   return s.message;   // Only exists in this variant.
    case "ready":   return render(s.data);
    default: {
      const _exhaustive: never = s;     // Adding a variant = compile error here.
      return _exhaustive;
    }
  }
}
```

Prefer this over `enum` — unions narrow properly, erase at runtime, and
interoperate with plain data:

```ts
export type Status = "draft" | "pending" | "approved" | "rejected";
```

### 2. Parse, don't validate — boundaries

A value is checked **once** at the boundary; after that, its type proves
validity. Hand-rolled guards are the canonical form (see §17 before reaching
for a schema library — one is justified only for genuinely large shapes):

```ts
export interface Project {
  readonly id: number;
  readonly title: string;
  readonly status: Status;
}

const STATUSES = ["draft", "pending", "approved", "rejected"] as const;

export function parseProject(input: unknown): Project {
  if (typeof input !== "object" || input === null) {
    throw new Error("Project: expected object");
  }
  const p = input as Record<string, unknown>;
  if (!Number.isSafeInteger(p.id)) throw new Error("Project.id: expected safe integer");
  if (typeof p.title !== "string" || p.title.length === 0) {
    throw new Error("Project.title: expected non-empty string");
  }
  if (p.title.length > LIMITS.titleBytesMax) {
    throw new Error("Project.title: exceeds limit");   // Bounds are checked at the boundary.
  }
  if (!STATUSES.includes(p.status as Status)) {
    throw new Error("Project.status: unknown value");
  }
  return { id: p.id, title: p.title, status: p.status as Status };
}

// Usage — the ONLY place a cast-like operation happens:
const project = parseProject(JSON.parse(raw) as unknown);
```

Rules:
- `JSON.parse(x)` is immediately bound to `unknown`, then validated.
- A predicate `x is T` is acceptable for narrowing, but a `parseX` that throws
  (or returns `Result`) is preferred — it *produces* a trustworthy value instead
  of merely claiming one.
- Parsers enforce the bounds from §10: max string lengths, max array sizes,
  integer safety. The boundary is where limits are cheapest to check.

### 3. Result type — expected failure in the signature

Expected failures are values. Programmer errors crash (§9). Never mix the two
channels: do not `catch` an assertion failure and convert it to a `Result`, and
do not return `err` for a violated invariant.

```ts
export type Result<T, E = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface AppError {
  readonly code: string;      // Stable machine code.
  readonly message: string;
}

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

Which channel:

| Situation | Channel |
|---|---|
| Network down, disk full, invalid user input, not found | `Result` — the caller must handle it |
| Broken invariant, impossible state, violated precondition | Assertion — crash loudly, fix the code |

Callers handle both `Result` branches (use §1's exhaustiveness). `catch` binds
`unknown` — narrow before use or wrap with `String(e)`. **All errors are
handled**: most catastrophic production failures come from incorrect handling of
errors that were explicitly signaled, not from the errors themselves.

### 4. Branded types — make lookalike primitives distinct

```ts
declare const brand: unique symbol;
export type Brand<T, B> = T & { readonly [brand]: B };

export type UserId  = Brand<string, "UserId">;
export type OrderId = Brand<string, "OrderId">;

export const toUserId = (s: string): UserId => {
  if (s.length === 0) throw new Error("UserId must be non-empty");
  return s as UserId;   // Assertion allowed ONLY here, after validation.
};

function getOrder(id: OrderId): void { /* ... */ }
// getOrder(userId) is a compile error, not a production bug.
```

### 5. Constants as types — one source of truth

```ts
export const LOCALES = ["en-us", "fr-fr", "de-de"] as const;
export type Locale = typeof LOCALES[number];   // Add to the array → type updates.

export const LIMITS = {
  pageSize: 20,
  maxRetries: 3,
  queueDepth: 1024,
  titleBytesMax: 256,
} as const satisfies Record<string, number>;
// `satisfies` checks the shape without widening literals away.
// Every bound in the system lives here or next to the code that enforces it.
```

### 6. Honest function signatures

- Everything the function can do must be visible in the signature: failure →
  `Result` or union return; absence → `T | undefined`; never a silent `null`
  when `undefined` is meant (pick `undefined` as the canonical "absent").
- **No boolean parameters** — they hide meaning at the call site:

```ts
// Bad:  fetchUsers(true, false)
// Good:
export function fetchUsers(opts: {
  readonly includeInactive?: boolean;
  readonly bypassCache?: boolean;
}): Promise<Result<readonly User[]>> { /* ... */ }
```

- Options objects use `readonly` properties and optional-with-defaults; avoid
  required-fields-after-optional (use a single options parameter).
- **Pass correctness-relevant options explicitly at the call site.** Never rely
  silently on a library's default for anything that matters — defaults change
  between versions, and the diff won't show at your call site.
- **Callbacks go last** in the parameter list. This mirrors control flow:
  callbacks are also *invoked* last.
- Type predicates for filters: `const defined = <T>(x: T | undefined): x is T =>
  x !== undefined;`
- **Keep signatures low-dimensional.** Each added branch in a return type is
  viral — it propagates handling cost up the whole call chain. `void` beats
  `boolean` beats `T` beats `T | undefined` beats `Result<T>`; use the simplest
  type that is still honest.

### 7. Immutability

```ts
export interface Config {
  readonly name: string;
  readonly tags: readonly string[];
}
```

- Function parameters and returns are `readonly` / `ReadonlyArray` by default.
- Update by construction (`{ ...prev, status: "approved" }`), not mutation.
- If a class mutates internal state, that state is `private` and never exposed
  by reference.
- **Local mutation is fine when it is centralized.** The function that owns the
  control flow may own local mutable state (§11); leaf helpers stay pure — they
  take values and return values. Don't confuse "immutable API boundaries" with
  "no local `let` anywhere".

### 8. Generics and narrowing discipline

- Constrain generics (`<T extends { id: string }>`); an unconstrained `T` that
  is only stored and returned is fine, but never use generics to launder types.
- **No function overloads** unless a union of signatures genuinely can't express
  it — prefer union parameter/return types or generics with conditional types.
- Template literal types for structured strings:
  `type Route = \`/${string}/v${number}\`` — validation at compile time.

### 9. Assertions — invariants are checked at runtime

Types prove structure; assertions prove the invariants types can't express. A
function must not operate blindly on data it has not checked — assertions
downgrade catastrophic correctness bugs into loud, findable crashes.

```ts
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}
```

Because of `asserts condition`, each assertion also narrows for the compiler —
runtime check and type information from one statement.

Rules:
- **Assert preconditions, postconditions, and invariants.** Core logic averages
  a minimum of two assertions per function. Boundary parsers already validate
  input, so internal assertions target *internal* invariants — the assumptions
  your own code makes.
- **Pair assertions.** For every property you enforce, find at least two code
  paths that check it: assert before writing to disk *and* after reading back;
  assert at the producer *and* the consumer.
- **Assert the positive space you expect AND the negative space you don't.**
  Interesting bugs live exactly where data crosses the valid/invalid boundary —
  which is also why tests must exercise invalid data, and valid data as it
  becomes invalid.
- **Split compound assertions.** `assert(a); assert(b);` over
  `assert(a && b);` — simpler to read, and the failure message tells you which
  condition broke.
- **Use a blatantly true assertion instead of a comment** where the condition is
  critical and surprising — documentation the machine enforces.
- Assertions are a safety net, not a substitute for understanding: build the
  mental model first, encode it as assertions, then let tests and fuzzing hunt
  for what you and your reviewer both missed.

### 10. Bounds — put a limit on everything

In reality, everything has a limit; code that doesn't state its limits will find
them in production, as a tail-latency spike or an OOM. Violations must fail
fast, near their cause.

- **Every loop has a provable upper bound.** `while (true)` is reserved for
  event loops, and those must assert progress or an explicit iteration cap.
- **Queues, retries, batches, pages, and caches are capped** — the constants
  live in `LIMITS` (§5), enforcement lives at the boundary or the point of
  accumulation. Hit the limit → backpressure or fail fast, never silent growth.
- **Parsers enforce maximum lengths** on strings and arrays (§2).
- **Prefer iteration to recursion.** Recursion needs a justified, asserted depth
  bound; an unbounded stack is an unbounded loop by another name.

### 11. Function shape and control flow

A function that fits on a screen is easier to read than one you must scroll
through, but length is a judgement, not a rule: no check counts lines.

- **When a function grows long, split it by responsibility**, not arbitrarily:
  - **Centralize control flow.** Push `if`s up and `for`s down: the parent
    function keeps the `switch`/`if` branching and owns the state; helpers
    contain non-branchy logic and stay pure. All control flow is handled by one
    function; the rest don't care about control flow at all.
  - Good function shape is often the inverse of an hourglass: few parameters,
    a simple return type, meaty logic between the braces.
- **Simple, explicit control flow.** Split compound boolean conditions into
  nested `if/else` branches; split long `else if` chains into trees so each
  case is visibly handled. Compound conditions make it impossible for the
  reader to verify that all cases are covered.
- **State invariants positively.** Negations are hard to reason about:

```ts
// Easy to get right — matches how index and count are normally compared:
if (index < count) {
  // The invariant holds.
} else {
  // The invariant doesn't hold — handle or assert.
}

// Harder, and against the grain: if (index >= count) { ... }
```

- **For every `if`, consider the matching `else`** — handle the negative space
  or assert it away (§9).
- **Always use braces**, even for one-line bodies — defense against
  "goto fail;"-class bugs.
- **Smallest possible scope.** Declare variables where they are first used,
  never before they are needed; minimize the number of variables in scope;
  calculate and check values close to their use. Bugs live in the gap between
  place-of-check and place-of-use.

### 12. Naming things

Great names capture what a thing is or does and show that you understand the
domain. Take time to find nouns and verbs that work together.

- **No abbreviations.** `source` and `target`, not `src` and `dest` —
  same-length related names have the second-order effect that derived variables
  (`sourceOffset`, `targetOffset`) line up in calculations. Exception:
  primitive loop counters. Use long-form flags in scripts: `--force`, not `-f`.
- **Units and qualifiers go last**, sorted by descending significance, so the
  name starts with the most significant word: `latencyMsMax`, not
  `maxLatencyMs`. Then `latencyMsMin` lines up beside it, and everything
  latency-related groups together.
- **Nouns over adjectives and participles.** `replica.pipeline`, not
  `replica.preparing` — a noun can be used directly in documentation,
  conversation, and derived identifiers (`config.pipelineMax`).
- **One name, one meaning.** Never overload a term with context-dependent
  meanings — if two domains collide, rename one.
- **Acronyms keep their capitalization**: `HTTPRequest`, `parseURL`.
- **Helpers are prefixed by their caller** when a function delegates:
  `readSector` and `readSectorCallback` show the call history in the name.
- TypeScript conventions apply throughout: `camelCase` for values and
  functions, `PascalCase` for types and classes.

### 13. Comments — say why, show how

Code alone is not documentation.

- **Comments are sentences**: a space after `//`, a capital letter, and a full
  stop (or a colon when introducing what follows). They are well-written prose,
  not scribblings in the margin. End-of-line comments may be unpunctuated
  phrases.
- **Say why.** Explain the rationale for non-obvious decisions; share the
  criteria a future reader needs to evaluate the code, not just to read it.
- **Say how.** Every test file opens with a comment block describing the goal
  and methodology of the test — enough for a reader to get oriented, or to skip
  sections, without reverse-engineering the intent.
- **Prefer an assertion to a comment** when the statement is a checkable
  invariant (§9).

### 14. Numbers — index, count, and size are different types

The usual suspects for off-by-one errors are casual interactions between an
index, a count, and a size. They are all `number`, but they are not the same
thing: indexes are 0-based, counts are 1-based, sizes carry a unit. Make the
distinction compile-time real:

```ts
export type Index     = Brand<number, "Index">;      // 0-based position.
export type Count     = Brand<number, "Count">;      // 1-based quantity.
export type SizeBytes = Brand<number, "SizeBytes">;  // Quantity × unit.
```

- Conversions are explicit and named: index → count adds one; count → size
  multiplies by the unit. Units appear in variable names (`timeoutMs`,
  `sizeBytes`, §12).
- **Show division intent.** `Math.floor`, `Math.ceil`, `Math.trunc` — never a
  bare `/` when the result feeds an index or a count. The reader must see that
  you thought through the rounding.
- **`number` is a float.** Check `Number.isSafeInteger` at boundaries; beyond
  2⁵³, use `bigint` and say so in the type.

### 15. Performance — think first, measure second

The best time to get the 1000× wins is the design phase, precisely when you
can't profile. Work with the grain.

- **Back-of-the-envelope sketches** over the four resources (network, disk,
  memory, CPU) and their two characteristics (bandwidth, latency). Sketches are
  cheap; be roughly right before you build.
- **Optimize the slowest resource first** (network → disk → memory → CPU),
  weighted by frequency of use — a cache miss repeated often enough costs as
  much as an fsync.
- **Batch.** Amortize network, disk, and CPU costs by batching accesses; drain
  queues at your program's own pace instead of reacting to every external
  event. Batching keeps control flow under your control and bounds work per
  time period.
- **Allocation in hot paths is a design decision, not an accident.** Hoist,
  reuse, and preallocate where the profile or the sketch says it matters.
- **Separate control plane from data plane.** Batching the data plane lets you
  keep high assertion density in the control plane without losing throughput.
- **Extract hot loops into standalone functions with primitive arguments** — a
  human reader (and the JIT) spots redundant work more easily.

### 16. File organization — order matters

A file is read top-down on first read, so put important things near the top.

- Public API and entry points first; internal helpers below.
- Complex nested types become top-level declarations.
- When no better order exists, sort alphabetically — big-endian naming (§12)
  makes related items adjacent.

### 17. Dependencies and tooling — a small, sharp toolbox

Dependencies bring supply-chain risk, safety and performance unknowns, and slow
installs; their cost is amplified through everything built on them.

- **Standard library and platform first.** Every new runtime dependency needs a
  written justification in the change that introduces it: what it does, why the
  platform can't, what it costs.
- **Hand-rolled parsers are canonical** (§2). A schema library (zod/valibot/
  arktype) is justified only when shapes are genuinely large enough that
  hand-rolling is the bigger risk.
- **One tool per job**: one formatter (Prettier), one linter (ESLint), one test
  runner. A small standardized toolbox beats an array of specialized
  instruments, each with a dedicated manual.
- **Scripts are TypeScript, not shell.** `scripts/*.ts` run with
  `node --experimental-strip-types` or `tsx` — cross-platform, type-checked,
  and runnable by everyone on the team instead of hitting Bash/OS-specific
  issues.
- **Commit messages are documentation.** Write descriptive messages that inform
  the reader — a PR description is invisible in `git blame` and is not a
  substitute.

---

## Forbidden patterns — reject in review

| Pattern | Do instead |
|---|---|
| `data as IProject` (unvalidated) | `parseProject(data)` / justified schema library |
| `any`, `as any`, `@ts-ignore` | `unknown` + narrowing; document the rare justified exception |
| `enum Status { … }` | string-literal union + `as const` array |
| `Partial<T>` parameter | explicit `Pick<T, "a" \| "b">` update type |
| `Record<string, any>` | `Record<string, unknown>` + validation, or a real type |
| `catch (e) { e.message }` | `catch (e: unknown)` → narrow or `String(e)` |
| catching an assertion failure into a `Result` | let programmer errors crash |
| boolean flags encoding state | discriminated union |
| `foo(bar: string, baz: string)` swaps | branded types |
| mutating a parameter | construct and return a new value |
| non-null assertion `x!` | handle `undefined` explicitly; restructure so it's unneeded |
| `null` and `undefined` both used | `undefined` for absence, consistently |
| unbounded `while` / growing queue | stated limit in `LIMITS`; fail fast at the bound |
| unbounded recursion | iteration, or a justified asserted depth bound |
| `assert(a && b)` | `assert(a); assert(b);` |
| `if (!(index >= count))` | positive form: `if (index < count) … else …` |
| compound boolean conditions | nested `if/else` trees |
| bare `/` for integer math | `Math.floor` / `Math.ceil` / `Math.trunc` with intent |
| relying on a library's defaults | explicit options at the call site |
| `src`, `dest`, abbreviations | `source`, `target` |
| shell scripts in the repo | TypeScript scripts |
| new dependency without justification | platform/stdlib first; written rationale otherwise |

## Testing expectations

### Repository contract surface

`shared/` is the only cross-process contract surface. Read
`docs/contracts.md` before changing page trees, scans, preload methods, IPC
channels, or renderer bridge modules. Values from IPC, disk, browser messages,
drag data, and `JSON.parse` stay `unknown` until the matching shared or feature
boundary parser accepts them. Generated or edited code must pass
`env -u ELECTRON_RUN_AS_NODE npm test`, which includes strict TypeScript,
ESLint, production builds, contract tests, and the complete regression suite.

- Type-level behavior is tested too: `expectTypeOf` (vitest) or `tsd` for
  public API types, exhaustiveness helpers, and brand separation.
- One parse-test per contract: known-good passes; each known-bad shape fails.
- **Test the negative space exhaustively** — not only valid data but invalid
  data, and valid data as it becomes invalid. Bugs live on that boundary (§9).
- Assertions are tested: violating an invariant throws, and the test pins the
  message.
- Runtime tests target the pure, `Result`-returning core; boundary code is thin
  enough to need only smoke tests.
- Where a state machine exists, property-based tests (e.g. fast-check) hunt the
  transitions you didn't think of. A fuzzer proves the presence of bugs, never
  their absence — the mental model and its assertions come first.
- When a GitHub release or publishing workflow fails, reproduce the cause locally and add or
  improve a regression test whenever possible before pushing again. This prevents the same
  failure from recurring only in GitHub. Follow [publishing failure handling](docs/releases.md).
  If local reproduction is impractical, document why and the verification that remains remote.

## Definition of done (checklist)

- [ ] No new `any`, assertions, non-null assertions, or `@ts-ignore` without a
      comment justifying the exception
- [ ] Every new boundary input has a parser and a test, including bound checks
- [ ] New state modeled as a discriminated union, not flags
- [ ] Switches over unions are exhaustive (`never` check / ESLint rule)
- [ ] Public API signatures are honest (failure and absence in the type)
- [ ] Expected failures return `Result`; programmer errors assert and crash —
      the channels are never mixed
- [ ] Invariants are asserted: preconditions, postconditions, pairs on both
      sides of storage; ~2 assertions per function in core logic
- [ ] Every loop, queue, retry, and collection has a stated upper bound
- [ ] Control flow is centralized, helpers pure
- [ ] Conditions are simple and positive; every `if` has its `else` handled or
      asserted
- [ ] Names are unabbreviated; units and qualifiers last; one name, one meaning
- [ ] Comments are sentences that say why; test files open with goal and
      methodology
- [ ] New dependencies carry a written justification
- [ ] `npm run check:changed` passes (`tsc`, ESLint, Prettier, policy scan)

## Project editor metadata

Project insertion defaults live in `.stacki/components.json`; column guide preferences
live in `.stacki/guide.json`. These are tracked project files shared by Desktop and Studio.
When moving or renaming an Astro component, update both its recipe key and every nested
`component` reference in `.stacki/components.json`. Do not put Stacki markup in Astro files.
Run `astro-studio check-project <project-directory>` against the installed Studio CLI after
refactors; missing paths, invalid slots and cyclic insertion recipes must be fixed together.
Ignore generated `.stacki/preview/` only, never the whole `.stacki/` directory.
