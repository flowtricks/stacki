# Package component libraries

Desktop and Studio read the same tracked `.stacki/component-sources.json` file. Local
components continue to work without configuration. Package sources add components to the
palette without copying their implementation into the site.

```json
{
  "version": 1,
  "sources": [
    {
      "kind": "package",
      "package": "@ffnext/site-kit",
      "directory": "src/lumos/components",
      "importPrefix": "@/components/"
    }
  ]
}
```

`directory` is relative to the installed package. `importPrefix` describes the imports the
site already supports through Astro/Vite or package exports. Stacki does not install a Vite
alias for the site. For example, `Button.astro` in this directory is inserted using
`@/components/Button.astro`. A package export prefix can be used instead when the package
exposes its components directly. Missing packages and overlapping source/import prefixes
produce errors rather than silently selecting another file.

Package components retain a project-relative identity such as
`node_modules/@ffnext/site-kit/src/lumos/components/Button.astro`. This identity is distinct
from the emitted import and from the package's canonical disk location. A local component
with the same filename remains a separate component. Existing matching imports are reused.
New local components prefer a verified tsconfig/jsconfig alias and otherwise use relative imports.

Schemas, slots, usage lookup and palette previews include configured package components.
Relative imported TypeScript declarations can be read within the configured package.
Discovery parses source without executing it. Preview rendering uses the site's normal
component runtime. Installed implementations are read-only; instance properties, slot content
and page markup remain editable. Package implementation changes belong in the package release.

Insertion recipes remain in `.stacki/components.json`, keyed by the component's identity.
Nested recipe references use that same identity. Package components can participate in recipes
alongside local components. Run `astro-studio check-project <project-directory>` after changing
sources or recipes to detect missing components, invalid slots and recipe cycles.

Only configured packages are scanned. Linked package roots, including pnpm and workspace
packages, are supported; symbolic links inside those packages are refused. Scans allow at most
16 sources, 1,000 directories, 10,000 Astro components and 16 MiB of component source.
Individual source reads are limited to 1 MiB. Restart or refresh the editor after updating a
dependency so its catalog and previews reflect the installed version.

# Pull request publishing

Select **Open a pull request for review** under **GitHub workflow** in Publish settings.
Both hosts save this choice in `.stacki/publish.json`:

```json
"githubWorkflow": { "kind": "pull-request" }
```

Omitting this setting preserves direct publishing. Review mode targets the configured Studio
branch or Desktop's current branch. The base branch must already exist on GitHub. Pull incoming
base changes before submitting. Desktop captures the current files without staging them,
switching branches, or committing to the working branch.

Each distinct parent/tree snapshot gets its own review branch. Submitting the same snapshot
again recovers its existing open PR, including after a lost response. Further edits produce
a new review rather than changing an earlier submission. An externally modified review branch
or closed PR requires attention; Stacki does not force-update or reopen it.

Review submission does not deploy, run publish hooks, clean up published assets, or advance
the draft synchronization baseline. Hosting-only publishing is refused while review mode is
enabled. Use repository CI to check, merge and deploy the reviewed changes. After merging,
sync the base branch through the normal incoming-change workflow before the next submission.

Desktop uses its selected GitHub CLI account. Studio requests a GitHub App installation token
with **Contents: write** and **Pull requests: write** for review submission. Existing direct
publishing still requests only Contents permission. Hosted Studio must be updated alongside
its server to expose the authenticated review connection endpoint.
