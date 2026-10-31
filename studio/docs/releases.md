# Studio releases and project updates

Stacki has one maintained editor. The root editor source supplies both Electron and
Studio; Studio's adapters replace native filesystem/IPC access with authenticated
requests to the project's Cloudflare Container. Collaboration and cloud deployment
remain host-specific. `scripts/shared-source.json` declares the assembly inputs.

## Versions

The desktop app runs its installed editor version for all local projects. It does
not execute an editor copied into a website. Each website owns its `studio/` source,
so Project A can keep hosted Studio 1.4.0 while Project B accepts 1.5.0. Desktop and
hosted version choices are independent. Website files stay ordinary Astro source.

The root Stacki version identifies both release artifacts. The release workflow
publishes `stacki-studio-VERSION.json` beside the desktop installers only after both
packages pass their gates. Publishing an artifact never updates customer projects.

## Accepting an update

The hosted account menu shows the installed Studio version. Updates are managed
through the CLI described below. Review and commit the updated Studio source, then
deploy the CMS. Publishing a new Stacki release does not change a hosted installation.

The replacement keeps website source/content/assets outside `studio/`, the project's
`studio/cloudflare/` configuration, `.env*`, `.dev.vars*`, `.studio`, `.studio-state`,
and `.wrangler` data. Cloudflare secrets and R2 drafts are external to the code tree.
Keep project-specific connection configuration in these retained locations. Source
code customizations elsewhere in Studio are replaced without attempting a merge.
An AI agent can help reapply selected customizations from Git history afterward.

## Local install or update

Build Studio in the canonical repository, or use the CLI from an installed release.
Stop the target project's local Studio server before replacing its installation.

```sh
node dist/cli.mjs check-update
node dist/cli.mjs update /path/to/site 1.5.0 --replace-customizations
```

The version is illustrative: use a version actually published in the Stacki release
feed. For a locally built bundle, pass its absolute JSON path instead of a version:

```sh
npm run release:bundle
node dist/cli.mjs update /path/to/site /path/to/stacki/studio/release/stacki-studio-VERSION.json --replace-customizations
```

The installer stages a clean release and runs dependency installation, both compiler
checks, and the build before replacing `site/studio`. A failure during validation
leaves the existing installation intact. The previous code is backed up under
`site/.stacki/studio/updates/backup-VERSION-ID`; settings and runtime state move to the new
installation. This metadata directory ignores its contents in Git. Review the
website's Git diff, commit the Studio replacement, and deploy when ready.

For a new installation, the template configuration is copied into `studio/cloudflare`.
Configure it using the Cloudflare guide. From the website directory, run
`npm --prefix studio run dev` to start a local draft.

## Recovery

Before rolling back, stop Studio and retain the current runtime state. Restore the
previous code from Git or the local backup, carrying the retained paths forward.
Then install dependencies and rebuild. Backups contain the previous code, not a
second copy of live drafts. Do not restore old draft snapshots over newer work.

An interrupted filesystem swap may leave staging, backup, and an `update.lock` in
`.stacki/studio/updates` (`.stacki-studio` before it moved there). These are deliberately retained. Inspect the directories, restore
`studio` and its retained state from them, and remove the stale lock only after
confirming the original updater is no longer running. No automatic garbage collection
removes backups or incomplete update directories.
