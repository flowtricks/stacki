# Static Studio demo

The real Studio client running on a finished site with no server. The demo builds it from
Studio's own client options (`scripts/studioClientBuild.ts`); the one difference is that Yjs
and TypeScript come from `demo.js`, so the page holds a single copy of each
(`demo/sharedYjs.ts`, `demo/sharedTypeScript.ts`).
`demo/` never ships to an install: it leaves this repository only as release assets
(`test/demoRelease.test.ts` holds that).

- `src/features/bake/` is the installable half: `astro-studio build-demo <project> --out <dir>`
  runs the project's own `astro build` with markers added in memory and writes the snapshot.
- `demo/` is the browser half: stand-ins for `fetch`, `WebSocket` and `EventSource`, a room per
  file, and the code that turns a source edit into a new rendering for morph.js.

## Compatibility

`BAKE_PROTOCOL` (`src/features/bake/bakeProtocol.ts`) is the contract between a baked site and
a client. Bump it whenever markers, section fences, runtime file names or the snapshot format
change. A site serves a newer client only when the protocols match, and otherwise keeps the one
it was built with until it rebuilds.

## Building and testing

    npm run release:demo                # .studio/demo-release/, and upload/ for the release
    npx tsx test/demo.browser.ts        # needs the line above first
