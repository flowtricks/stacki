# Tests

```bash
npm test                                   # the gate — run this before every commit
npm run roundtrip:report                   # where the parser stands, and what is left to fix
node scripts/roundtrip-report.js ~/a-site  # same report against any Astro project
STACKI_CORPUS=~/a-site npm test            # crash-sweep a real project as part of the gate
```

## The round-trip gate

Stacki edits files it did not write. The contract that makes that safe is:

> Parsing a page and serializing it straight back must return **the original bytes**.

Anything else means opening a file and saving it rewrites parts the user never
touched — reformatted markup, reordered imports, lost blank lines. That turns a
one-prop change into a whole-file diff in their git history, and in the worst case
changes what the page does.

`roundtrip.test.js` checks five properties against every fixture in `corpus/`:

| # | Property | Why |
|---|---|---|
| 1 | `parsePage` never throws | A crash on someone's project is the worst possible first impression |
| 2 | Editability is stable | A file silently dropping to code view is a feature regression |
| 3 | parse → serialize is identity | The contract above |
| 4 | Serialization is idempotent | Weaker fallback: if a file *is* damaged, it is damaged once, not on every save |
| 5 | One edit → one-line diff | Measures blast radius. Checked against the serializer's own output, so it stays meaningful while #3 is still failing |

## Known failures

`expectations.json` lists fixtures that **currently fail** property 3, each with the
root cause and a `severity`:

- **`corruption`** — the output is not equivalent to the input. It changes meaning
  or is invalid Astro. These are bugs.
- **`formatting`** — semantically the same file, reformatted. Still unacceptable
  for a tool that edits other people's repos, but it won't break a build.

The gate asserts a known failure **still fails**. So when a fix lands, the test goes
red with *"delete its entry from expectations.json"* — the fix cannot land silently,
and the fixture immediately becomes a permanent regression test.

That makes `expectations.json` the parser worklist. Shrinking it to `{}` is the goal.

## Adding a fixture

1. Drop a minimal, valid `.astro` file in `corpus/` named after the shape it covers.
2. Run `npm test`.
3. If it passes, you're done — it now guards that shape forever.
4. If it fails, that's a real defect. Add an entry to `expectations.json` with the
   root cause (file:line) and a severity, and it becomes tracked work.

Fixtures should be **minimal and single-purpose**: one shape per file, named for the
shape. `named-imports.astro` covers named imports, not named imports *and* slots.

Currently uncovered, worth adding: CRLF line endings, `.mdx`, framework components
(`.jsx`/`.vue`/`.svelte`), dynamic routes (`[slug].astro`), TypeScript path aliases
in import specifiers.
