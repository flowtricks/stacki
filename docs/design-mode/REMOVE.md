# Design mode (experimental): how it works, why it cannot write, and how to take it out

Design mode is the normal editor working on a sandbox: a private copy of the project in Stacki's own data folder.
Turning it on (the AI panel's Modes menu) copies the project and opens the copy through the app's own project
switch, so the Navigator, the Style and Settings panels, Add elements, Components, Assets and the canvas all work
on it for real. Frames are versions of that copy: duplicate one, change it, switch between them, compare them side
by side, and send them to the AI. Nothing is saved to the project.

## Switching it off without removing it

Set `DESIGN_MODE_ENABLED` to `false` in `shared/ipc/designSession.ts`. The Modes menu then has no Design mode row,
and main refuses to begin a session.

## Why it cannot write to the project

- **The copy is elsewhere.** `electron/handlers/designMode/designSandbox.ts` copies the project to
  `<user data>/design-sandboxes/<id>/` (on macOS `~/Library/Application Support/Stacki/`), folders mode 0700, with
  node_modules cloned copy-on-write. A project that links outside itself is refused, because a write through such a
  link would leave the copy.
- **Requests are fenced.** Every invoke channel passes the IPC registrar, which calls `checkDesignFence`
  (`electron/lib/designMode/designFence.ts`). While the mode is on only the channels in `DESIGN_CHANNELS` run;
  everything else (git, publishing, the terminal, the AI agent, Stacki apps, secrets, MCP writes, remote content
  writes, app settings, recents, and any channel added later) is refused. git's branch question is answered
  "no repository", so the shell's polling never shows a refusal; the shell's read-only polls of apps, publishing
  state and secret names are answered from the copy for the same reason. A request that runs must name the copy
  as its project, may not name a path in the project, and may not climb out with `..`.
- **Writes are fenced.** `electron/lib/designMode/designWriteGuard.ts` wraps every Node file system call that
  creates, changes or removes a file. While the mode is on, a write outside the copy, Stacki's data folder and the
  temporary folder fails with EACCES before it runs, whatever code path made it.
- **The window shows what can work.** Features a copy cannot give (history and git, publishing, apps, project
  secrets and MCP settings, roles, the command line) are hidden through the app's own "View as" preview
  (`src/app/designMode/designRole.ts`). The AI panel stays, for the Modes menu; sending a prompt is refused.
- **The copy does not outlive the session.** It is deleted, with its `.env`, when the window leaves it, when the app
  quits, and, for a copy a crash left behind, the next time the app starts.
- **Undo history from before is cleared**, on the way in and on the way out: the window reloads, as it does for any
  project switch. A toast says so each time.
- **Drafts** (each frame's changed files and its picture) are kept in `<user data>/design-drafts/<hash>/`, mode
  0700, never in the project. Secrets (`.env*`, key files) are never kept in a draft.

`test/electron/handlers/designMode/designSession.test.ts` holds each of these properties with real folders;
`test/renderer/app/designMode/designModeSoak.test.js` runs them in the real app and checks the project folder is
byte-identical afterwards.

## Removing it

1. Delete these folders and files:
   - `src/app/designMode/`
   - `electron/handlers/designMode/`
   - `electron/lib/designMode/`
   - `shared/ipc/designSession.ts`
   - `src/features/style/model/inlineDefault.ts`
   - `test/renderer/app/designMode/`
   - `test/electron/handlers/designMode/`
2. Revert these lines, each marked `Design mode (experimental)`:
   - `src/app/shell/AppShell.tsx`: the `import { DesignModeHost } …` line and the `<DesignModeHost app={app} />` line.
   - `electron/main.ts`: the two imports (`registerDesignModeHandlers`, `designFenceState`), the
     `registerDesignModeHandlers(…)` line, and in `relaunchApp` the two `fence` lines, back to
     `fs.writeFileSync(reopenFile(), JSON.stringify({ path: openProjectRoot }), 'utf8');`.
   - `electron/lib/ipcRegistrar.ts`: the `checkDesignFence` import, the `const fenced = …` line and the
     `if (fenced.kind === 'answer') { … }` block after it.
   - `electron/preload/preloadBridge.ts`: `designSession: invoke('design:session'),`.
   - `shared/ipc/ipcPayloads.ts`: the `DESIGN_SESSION_PAYLOADS` import and its spread.
   - `shared/ipc/ipcResults.ts`: the `DesignSessionResults` import, the comment line above `IpcResults`, and
     `, DesignSessionResults` in its `extends` list.
   - `shared/ipc/preloadApi.ts`: `readonly designSession: 'design:session';`.
   - `src/features/style/embed/useInlineTarget.ts`: the `inlineDefault` import, `|| startsInline(style, inline)` in
     `inlineTargetOf`, the `startsInline` function, the `style.kind === 'none'` branch in `useInlineCard`, the `useInlineByDefault(…)` call in `useInlineCard`, and the
     `useInlineByDefault` function at the end of the file.
   - `studio/scripts/shared-source.json`: the `shared/ipc/designSession.ts` and
     `src/features/style/model/inlineDefault.ts` entries.
3. Optionally delete `design-drafts/` (and `design-sandboxes/`, which is empty unless the app crashed during a
   session) from Stacki's user data folder: once the feature is gone nothing reads or sweeps them.

Kept on purpose: the Modes menu and its registry (`src/features/ai/panelModes.ts`, `sessions/ModesMenu.tsx`), which
belong to comment pins too. Nothing outside the lists above changes.
