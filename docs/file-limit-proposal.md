# Brief: Replacing the 800-Line Limit (TypeScript)

**Status:** Proposal · **Owner:** Nick · **Scope:** `src/**/*.{ts,tsx}` · **Supersedes:** `max-lines: 800`

---

## TL;DR

The 800-line limit was removed because it was frustrating and appeared to make agent output *more* complex. Both observations are correct, and both trace to one defect: **the rule bounded file length but not code density.** A cap on length alone tells the model which variable to raise, and it raises the free one — nested ternaries, `reduce` chains, options-bag factories, `as` casts.

**Recommendation:** replace the flat line limit with a **complexity budget as the primary gate**, a **line cap derived from measured density**, and an **absolute ceiling that never moves**. Long-but-simple files (types, tables, schemas) become explicitly legal; short-but-dense files get blocked. Loosen the wall, tighten the shape.

---

## 1. What actually went wrong

A TS file's raw line count is mostly not logic:

| Content | Share of a typical 800-line file | Should it count? |
|---|---|---|
| Imports + type imports | 30–60 lines | No |
| Interfaces / types / generics | 80–250 | No |
| Comments + JSDoc | 30–100 | No |
| Statements | remainder | Yes |

So `max-lines: 800` fired on well-typed modules at ~450 real lines, while a 790-line file of `any`-riddled one-liners passed. The two cheapest ways to comply were **delete the comments/types** and **densify the code**. The second is the "overly complex" complaint, and it is a predictable response, not a model quirk:

$$C_{\text{file}} \approx L \times \bar{d}$$

Capping $L$ leaves $\bar{d}$ unconstrained. Every optimizer — human or agent — spends the free variable.

**Corollary:** a bare `max-lines` rule is not a size rule. It is a density *incentive*.

---

## 2. The proposed rule

Two budgets per file, plus a fixed wall:

$$\text{block if}\quad C > C_{\text{budget}} \quad\text{or}\quad L > \min\!\left(L_{\text{hard}},\ \frac{C_{\text{budget}}}{\max(d,\ C_{\text{budget}}/L_{\text{hard}})}\right),\quad d = \frac{C}{L}$$

- $L$ = code lines (blanks, comments, imports, type-only declarations excluded)
- $C$ = **cognitive** complexity (not McCabe — it weights nesting and doesn't linearly punish flat `switch` over a large union)
- $C_{\text{budget}}$, $L_{\text{hard}}$ = constants, per path profile

**Behavior:** sparse files approach $L_{\text{hard}}$ and pass. Dense files get a cap well under it. Lines stop being the judgment and become a derived quantity.

| File | $L$ | $C$ | Verdict |
|---|---|---|---|
| `constants.ts` (tables) | 900 | 2 | **pass** |
| `invoice.types.ts` | 1400 | 0 | **pass** (types profile, exempt) |
| `invoice-service.ts` | 420 | 36 | **pass** |
| same, after growth | 700 | 90 | **block** (both axes) |
| `adapters.ts` (thin wrappers) | 880 | 45 | **pass** |
| `pdf.tsx` | 480 | 64 | **block** (component profile) |

### Profiles

| Profile | Glob | $C_{\text{budget}}$ | $L_{\text{hard}}$ |
|---|---|---|---|
| logic | `src/**/*.ts` | 80 | 1000 |
| component | `src/**/*.tsx` | 60 | 500 |
| hook | `src/**/use*.ts` | 40 | 250 |
| types | `*/*.types.ts`, `*.d.ts` | exempt | 2000 |
| schema | `*/*schema*.ts` | 20 | 600 |
| test | `*.test.ts{,x}` | 300 | off |
| generated | `**/generated/**` | excluded | excluded |

### Function-level companion

Gate `max-lines-per-function: 60`, `max-depth: 3`, `max-params: 4`, `complexity: 12`, `sonarjs/cognitive-complexity: 15`, `no-nested-ternary`. **These are what close the loophole** — once densifying is separately blocked, decomposition is the only move that satisfies the gate.

Optional, once coverage runs in CI: **CRAP** at function level.

$$\mathrm{CRAP}(f) = CC(f)^2\,(1-\text{cov}(f))^2 + CC(f)$$

Threshold 30. This is the only genuinely dynamic metric in the set — it moves per commit — and it gives the agent two legitimate exits: split the function, or test it.

---

## 3. Rollout

| Phase | Action | Effort |
|---|---|---|
| **0 — now** | Remove nothing. Add density rules only (`max-lines-per-function`, depth, complexity, `no-nested-ternary`). No file fails a *new* gate. | ~1 hour |
| **1 — week 1** | Add two-budget check at **nudge** level (500 lines / warn). Add `loc-budget.yaml` freezing every file already over budget at current size. | ~1 day |
| **2 — week 2–3** | Flip to **block** for new files. Ship `move_symbol` tool (ts-morph + `fixMissingImports` + `organizeImports`). Enable `verbatimModuleSyntax`, ban `export *` barrels, gate `import/no-cycle`. | ~2 days |
| **3 — week 4+** | Nightly ratchet: lower each frozen budget 3–5% (floors: 400 lines / 50 cognitive). Open issues for worst CRAP functions. | scheduled job |

**Freeze semantics are non-negotiable.** Files over budget may *shrink* and may not *grow*; they are never refused edits outright. Refusing a 3-line bugfix in a legacy file is precisely what made 800 feel punitive and got it deleted.

---

## 4. Anti-gaming controls

Every budget redirects the optimization target. Ship these with the rule, not after.

| Exploit | Control |
|---|---|
| Split into N files each at budget | `import/no-cycle`; ≤ 25 files/dir; every new module needs ≥ 1 importer |
| Push complexity into a 40-case `switch` | Cognitive (not McCabe) as primary |
| Satisfy cap via `eslint-disable` | Ban disables on size/complexity rules; `--report-unused-disable-directives`; track disable count as its own ratchet |
| 20 tiny files, logic unchanged | `max-lines` **minimum** (~40 non-test); dup-block detection; ≤ 10 public symbols/module |
| Inflate coverage with assertion-free tests | Stryker on top-10 CRAP functions; assert count per test |
| Amend the budget config | Config requires review + CODEOWNERS; budget history versioned like a schema migration |

**Do not gate on:** Maintainability Index, Halstead volume/effort (log terms make them near-flat in the relevant range, and both are trivially gameable by renaming). Dashboards only. Instability/distance metrics are useful for *choosing a split target*, not for blocking.

---

## 5. Why this resolves the complaint

| Complaint | Addressed by |
|---|---|
| "The limit was frustrating" | 800 → 1000 ceiling; sparse files exempt in practice; existing files frozen rather than blocked |
| "It made the AI write overly complex code" | Density is now capped independently; components/functions/hooks have their own budgets; complexity, not length, is the gate |
| (unstated) "But we still want a bound" | $L_{\text{hard}}$ and $C_{\text{budget}}$ are constants in the repo and do not move |

Expected outcome: the gate fires on genuinely dense files and stops firing on `types.ts`, `constants.ts`, and thin-wrapper modules — a modest reduction in false positives (est. 20–30% fewer), and a large reduction in the density incentive that caused the original problem.

---

## 6. Open questions

1. **Do we have coverage in CI today?** If no, drop CRAP from scope and rely on cognitive complexity alone. If yes, it's nearly free.
2. **Tuning budget:** first two weeks will produce false positives. Who triages? Suggest the rule owner, with a shared channel.
3. **`adapters.ts`-style files:** is 1000 the right ceiling, or do we want a per-directory escape with a named owner? Silence is what turns an exemption into a permanent god file.
4. **Do we adopt `move_symbol` before or after the block phase?** Recommendation: before. Splitting becomes cheap only when the tool exists; enforcing first trains the team to hate the rule again.

---

<details>
<summary><b>Appendix: artifact checklist</b></summary>

- [ ] `eslint.config.js` — density rules + two-budget rule + per-path profiles
- [ ] `scripts/loc-budget.ts` — deterministic cap computation, structured error with `measured` / `budget` / `violated` / `seams`
- [ ] `loc-budget.yaml` — profiles, freeze list, ratchet config
- [ ] `scripts/move-symbol.ts` — ts-morph mover
- [ ] `scripts/loc-ratchet.mjs` — `--check` (CI) and `--lower` (nightly)
- [ ] `tsconfig.json` — `verbatimModuleSyntax: true`
- [ ] CODEOWNERS entry for `loc-budget.yaml` and `eslint.config.js`
- [ ] Agent instruction block (size discipline, write-scope grant, prohibited shortcuts)

**Error contract the agent sees:**

```json
{
  "code": "BUDGET_EXCEEDED",
  "profile": "logic",
  "measured": { "lines": 700, "cognitive": 90 },
  "budget":   { "lines": 622, "cognitive": 80 },
  "violated": ["cognitive-complexity", "derived-lines"],
  "seams": [ { "symbols": ["renderPdf", "renderHtml"], "target": "src/billing/render.ts" } ]
}
```

Always disclose the numbers. An agent that can compute its exact budget plans around it; an agent that can't will thrash.

</details>
